import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * Estado de Ajustes que decide si se puede salir (#281).
 *
 * Solo la ventana de Ajustes lo conoce: el backend no puede saber si hay un
 * borrador sin guardar ni un guardado en curso.
 */
export interface NexoQuitState {
  /** Hay cambios manuales sin guardar. */
  dirty: boolean;
  /** Hay un guardado en curso (manual o vivo). */
  saving: boolean;
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
      const state = reader?.() ?? { dirty: false, saving: false };
      void invoke('nexo_quit_answer', { token: event.payload, dirty: state.dirty, saving: state.saving }).catch(() => {
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
