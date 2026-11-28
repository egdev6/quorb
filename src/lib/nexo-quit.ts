import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { LiveState } from './settings-live';

/**
 * Estado de Ajustes que decide si se puede salir (#281).
 *
 * Solo la ventana de Ajustes lo conoce: el backend no puede saber si hay un
 * borrador sin guardar, un guardado en curso ni un autoguardado fallido.
 */
export interface NexoQuitState {
  /** Hay cambios manuales sin guardar. */
  dirty: boolean;
  /** Hay un guardado en curso (manual o vivo). */
  saving: boolean;
  /** Un autoguardado falló y el cambio NO está persistido. */
  failed: boolean;
  /** Un ajuste se persistió pero su efecto nativo falló (p. ej. «siempre encima»). */
  applyFailed: boolean;
}

/** Señales de Ajustes de las que se deriva `NexoQuitState`. */
export interface NexoQuitSignals {
  /** Cambios manuales sin guardar. */
  dirty: boolean;
  /** Guardado manual en curso. */
  manualSaving: boolean;
  /** Estado del autoguardado vivo; sus errores marcan fallos sin resolver. */
  live: Pick<LiveState, 'saving' | 'pending' | 'error' | 'saveError'>;
}

/**
 * Deriva el estado que se envía al hub a partir de las señales de Ajustes.
 *
 * Un autoguardado rechazado deja el saver en `saving:false, pending:false` con
 * el error puesto: el cambio no está persistido, así que salir lo perdería. Por
 * eso `failed` es una señal propia y no se pliega en `saving`.
 *
 * `failed` y `applyFailed` se distinguen porque no es lo mismo: un rechazo de
 * escritura deja el dato sin guardar, mientras que un efecto nativo que falla
 * tras persistir deja la configuración guardada y solo sin aplicar. Bloquean
 * igual, pero el motivo que ve el usuario no es el mismo.
 */
export function quitStateFrom(signals: NexoQuitSignals): NexoQuitState {
  return {
    dirty: signals.dirty,
    saving: signals.manualSaving || signals.live.saving || signals.live.pending,
    failed: signals.live.saveError !== null,
    applyFailed: signals.live.error !== null && signals.live.saveError === null,
  };
}

/** Lee el estado vigente de Ajustes. */
type StateReader = () => NexoQuitState;

let reader: StateReader | null = null;
let unlisten: (() => void) | null = null;

/**
 * Registra el estado de Ajustes que el hub de Nexo consulta antes de salir.
 *
 * El backend pregunta con el evento `nexo-quit-request` y espera la respuesta
 * con el comando `nexo_quit_answer`: aquí solo se reporta el estado, y la
 * decisión final (aceptar o rechazar con motivo localizado) vive en
 * `nexo_policy`, donde se testea.
 *
 * Devuelve la función para dar de baja el registro. El listener se queda vivo:
 * es por ventana, y solo la ventana de Ajustes puede recibir el evento.
 */
export function registerNexoQuitState(read: StateReader): () => void {
  reader = read;
  if (!unlisten) {
    void listen<number>('nexo-quit-request', (event) => {
      // Sin lector no se sabe si hay cambios sin guardar: no se responde y deja
      // que el timeout del plugin rechace. Responder «se puede salir» a ciegas
      // podría perder trabajo (p. ej. entre el desmontaje de Ajustes y la
      // destrucción de su ventana, el listener sigue vivo sin lector).
      const state = reader?.();
      if (!state) return;
      void invoke('nexo_quit_answer', {
        token: event.payload,
        dirty: state.dirty,
        saving: state.saving,
        failed: state.failed,
        applyFailed: state.applyFailed,
      }).catch(() => {
        // Sin respuesta el backend rechaza por tiempo agotado: un fallo aquí no
        // debe romper la ventana de Ajustes.
      });
    }).then((off) => {
      unlisten = off;
    });
  }
  return () => {
    if (reader === read) reader = null;
  };
}
