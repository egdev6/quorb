import { invoke } from '@tauri-apps/api/core';
import type { AlertMoment, AppConfig, Effect, Sample, ScopedSecretKey, SecretStatus, UsageReport } from './types';
// Tipos del contrato de la instalación asistida de Codex. Solo tipos: evita un ciclo de ejecución.
import type { CodexInstallResult, CodexSetupStatus } from './codex-install';
import type { SurfaceClip } from './surface-clip';
import type { PhysicalBounds } from './detail-panel';
import type { WidgetPlacementReport, WidgetPlacementRequest } from './widget-placement';

/** Campos que el widget puede cambiar sin arrastrar el resto de la config. */
export interface WidgetPatch {
  dockEdge?: AppConfig['dockEdge'];
  dockOffset?: number;
  dockMonitor?: string | null;
  providerOrder?: string[];
  hiddenProviders?: string[];
  /** Personalización inmediata (#97): mismo merge atómico del backend. */
  opacity?: number;
  compact?: boolean;
  showResets?: boolean;
  autoHide?: boolean;
  alwaysOnTop?: boolean;
  orbSize?: number;
  accentColor?: string;
}

/**
 * Resultado de un patch atómico. `nativeError` describe un efecto nativo (p. ej.
 * «siempre encima») que falló **después** de que la config ya quedara persistida:
 * es un estado parcial recuperable, nunca un éxito total ni un rollback.
 */
export interface ConfigPatchOutcome {
  config: AppConfig;
  nativeError: string | null;
}

/** Patch atómico con resultado completo (config + posible fallo nativo). */
const patchConfigOutcome = (patch: WidgetPatch) => invoke<ConfigPatchOutcome>('patch_config', { patch });

export const api = {
  getConfig: () => invoke<AppConfig>('get_config'),
  saveConfig: (config: AppConfig) => invoke<AppConfig>('save_config', { config }),
  /** Merge atómico de los campos del widget: no toca cuentas ni secretos. */
  patchConfig: async (patch: WidgetPatch): Promise<AppConfig> => (await patchConfigOutcome(patch)).config,
  /** Igual que `patchConfig` pero conserva el fallo nativo para un error recuperable. */
  patchLiveConfig: patchConfigOutcome,
  secretStatus: () => invoke<SecretStatus>('secret_status'),
  setSecret: (key: ScopedSecretKey, value: string) => invoke<void>('set_secret', { key, value }),
  fetchUsage: () => invoke<UsageReport[]>('fetch_usage'),
  openLogin: (provider: string) => invoke<void>('open_login', { provider }),
  /** Cambia cuando un CLI renueva su sesión (fechas de sus ficheros de credenciales) */
  sessionStamp: () => invoke<number>('session_stamp'),
  /**
   * ¿Existe ya el fichero de credenciales de esta cuenta? Solo presencia del
   * fichero: no valida que la sesión guardada siga sirviendo. Comando
   * `account_session` del backend.
   */
  accountSessionFileExists: (id: string) => invoke<boolean>('account_session', { id }),
  /** CLIs de login instalados: `{ claude, codex, gemini }` */
  cliStatus: () => invoke<Record<string, boolean>>('cli_status'),
  /**
   * Estado pasivo de la instalación asistida de Codex CLI. Solo lee: nunca
   * ejecuta procesos, red ni escrituras. Comando `codex_setup_status`.
   */
  codexSetupStatus: () => invoke<CodexSetupStatus>('codex_setup_status'),
  /**
   * Pide instalar Codex CLI. El backend abre el diálogo nativo de Windows y solo
   * instala si se confirma; puede rechazar con un error genérico acotado.
   * Comando `install_codex`.
   */
  installCodex: () => invoke<CodexInstallResult>('install_codex'),
  /** Consulta una cuenta (principal o adicional) con lo guardado, aunque esté oculta */
  checkProvider: (id: string) => invoke<UsageReport | null>('check_provider', { id }),
  openSettings: () => invoke<void>('open_settings'),
  showDetail: () => invoke<boolean>('show_detail'),
  setDetailBounds: (bounds: PhysicalBounds) => invoke<void>('set_detail_bounds', { bounds }),
  /**
   * Coloca la tira y devuelve la geometría que quedó en pantalla (#179): el
   * backend es la autoridad y responde con el read-back, no con la solicitud.
   * La petición lleva el borde anclado y el factor con el que se calculó el
   * rectángulo: con otro tamaño efectivo, el borde se conserva y la conversión
   * no depende del factor de la ventana (DPI mixto).
   */
  setWidgetBounds: (placement: WidgetPlacementRequest) => invoke<WidgetPlacementReport>('set_widget_bounds', { bounds: placement }),
  /** Cancela la colocación pendiente: el usuario empezó a arrastrar la tira (#179). */
  cancelWidgetPlacement: () => invoke<void>('cancel_widget_placement'),
  setSurfaceClip: (clip: SurfaceClip, backdrop = true) => invoke<void>('set_surface_clip', { clip, backdrop }),
  setTrayTooltip: (text: string) => invoke<void>('set_tray_tooltip', { text }),
  getHistory: (provider: string, hours: number) => invoke<Sample[]>('get_history', { provider, hours }),
  nanProbe: () => invoke<string>('nan_probe'),
  nanLoginRequest: (email: string) => invoke<void>('nan_login_request', { email }),
  /** Devuelve el usuario conectado. `account`: id de una cuenta adicional de NaN */
  nanLoginComplete: (link: string, account?: string) => invoke<string>('nan_login_complete', { link, account: account ?? null }),
  /**
   * 9Router: guarda la contraseña del dashboard local, inicia sesión y devuelve
   * las stats en crudo. La cookie de sesión la conserva el backend.
   * `baseUrl` es la del borrador de Ajustes (si el usuario la cambió sin guardar).
   */
  nineRouterLogin: (password: string, baseUrl?: string) => invoke<string>('nine_router_login', { password, baseUrl: baseUrl ?? null }),
  /** 9Router: desconecta borrando contraseña y cookie de sesión guardadas. */
  nineRouterLogout: () => invoke<void>('nine_router_logout'),
  /** Rectángulo del monitor en píxeles físicos */
  playEffect: (
    kind: Exclude<Effect, 'none'>,
    moment: AlertMoment,
    rect: { x: number; y: number; width: number; height: number },
  ) => invoke<void>('play_effect', { req: { kind, moment, ...rect } }),
  overlayDone: () => invoke<void>('overlay_done'),
  shortcutErrors: () => invoke<string[]>('shortcut_errors'),
  shortcutWarnings: () => invoke<string[]>('shortcut_warnings'),
};
