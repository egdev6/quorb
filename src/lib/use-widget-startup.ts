// Lógica de arranque del widget respecto a la CONFIGURACIÓN (#271).
//
// Aislada en un hook para poder probar el cableado (temporizador de 2,5 s de la
// red de seguridad, estados de config pendiente/fallo definitivo) con
// `vi.useFakeTimers` y mocks de `api`/`listen`, como las demás piezas del
// arranque en `src/lib/*.test.ts`. `Widget` la consume y conecta el resto.
//
// Contrato (revisión PR #271):
// - `configFailed` solo se marca cuando `getConfig` agota sus reintentos en el
//   ARRANQUE: es el «fallo definitivo de carga de configuración». Los fallos de
//   refresco, arrastre o actualización son del `error` genérico de `Widget` y
//   NO desactivan el estado neutro pendiente.
// - Al aplicar una config válida se limpia `configFailed`/`configError`: una
//   config que llega tarde no deja colgado un fallo previo.
// - La red de seguridad (`window.show()` a los 2,5 s) vive aquí como
//   `onReadyToShow` inyectable: el hook no conoce Tauri, `Widget` pasa el
//   callback real (visible si no está oculta por el usuario, #179). Mantiene la
//   protección de arranque sin retrasar `show()` ni tocar la colocación.
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api } from './api';
import { retryWithBackoff, STARTUP_RETRY } from './startup';
import type { AppConfig } from './types';

/** Milisegundos de la red de seguridad: mostrar la ventana aunque la
 *  colocación/la config sigan pendientes (Widget.tsx; #271). */
export const STARTUP_SHOW_DELAY_MS = 2500;

export interface WidgetStartupOptions {
  /** Se llama a los 2,5 s si la ventana aún no se ha mostrado (red de seguridad). */
  onReadyToShow?: () => void;
  /** Efecto secundario al aplicar una config (p. ej. Widget vacía los informes
   *  al cambiar de entorno — #248). Se llama con la config recién aplicada. */
  onConfigChange?: (next: AppConfig) => void;
}

export interface WidgetStartupState {
  /** Config válida, o `null` mientras no llega. */
  config: AppConfig | null;
  /** Los reintentos de `getConfig` del arranque se agotaron: fallo definitivo. */
  configFailed: boolean;
  /** Texto crudo del fallo definitivo de config (solo útil si `configFailed`). */
  configError: string | null;
  /** Aplica una config válida (mount, `config-changed` o reintento manual). */
  applyConfig: (config: AppConfig) => void;
}

export function useWidgetStartup(options: WidgetStartupOptions = {}): WidgetStartupState {
  const { onReadyToShow, onConfigChange } = options;
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  // Generación de config: aplicar una config (o empezar una lectura nueva)
  // invalida las lecturas en vuelo iniciadas antes, de modo que un `getConfig`
  // del arranque que resuelve tarde no pise una config más nueva aplicada por
  // `config-changed` o por un reintento manual (revisión PR #271).
  const generation = useRef(0);

  const applyConfig = useCallback((next: AppConfig) => {
    generation.current += 1;
    setConfig(next);
    // Config válida: deja de estar pendiente y despeja el fallo definitivo.
    setConfigFailed(false);
    setConfigError(null);
    onConfigChange?.(next);
  }, [onConfigChange]);

  // Carga de la config: reintentos en el arranque + `config-changed`.
  useEffect(() => {
    const controller = new AbortController();
    const startedAt = generation.current;
    // Solo el fallo del PRIMER getConfig (reintentos agotados) es «fallo
    // definitivo»: los fallos posteriores de config-changed no deben sacar al
    // widget del estado pendiente (revisión PR #271, precisión 1).
    // `controller.signal.aborted` es el único guard de desmontaje: abortar el
    // retry rechaza la promesa en vuelo, y los callbacks lo consultan en vez
    // de mantener un flag `alive` paralelo (revisión PR #271, menor).
    retryWithBackoff(() => api.getConfig(), { ...STARTUP_RETRY, signal: controller.signal })
      .then((c) => {
        if (controller.signal.aborted || generation.current !== startedAt) return;
        applyConfig(c);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted || generation.current !== startedAt) return;
        setConfigFailed(true);
        setConfigError(e instanceof Error ? e.message : String(e));
      });
    const off = listen('config-changed', () => {
      const startedAt = generation.current;
      api
        .getConfig()
        .then((c) => {
          if (controller.signal.aborted || generation.current !== startedAt) return;
          applyConfig(c);
        })
        .catch(() => {
          /* la próxima lectura (o el reintento manual) lo resuelve */
        });
    });
    return () => {
      controller.abort();
      off.then((f) => f());
    };
  }, [applyConfig]);

  // Red de seguridad: si a los 2,5 s la ventana sigue sin mostrarse, `Widget`
  // muestra igualmente la tira (el estado neutro no emite textos localizados).
  useEffect(() => {
    if (!onReadyToShow) return;
    const t = window.setTimeout(onReadyToShow, STARTUP_SHOW_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [onReadyToShow]);

  return { config, configFailed, configError, applyConfig };
}
