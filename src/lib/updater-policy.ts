import { invoke } from '@tauri-apps/api/core';

export type UpdaterMode = 'unknown' | 'manual' | 'native' | 'error';
let policy: Promise<UpdaterMode> | undefined;

/** Política del binario, compartida por ventana. Un fallo bloquea el updater hasta reiniciar. */
export function getUpdaterMode(): Promise<UpdaterMode> {
  policy ??= Promise.resolve().then(() => invoke<unknown>('updater_mode')).then(
    (mode): UpdaterMode => mode === 'manual' || mode === 'native' ? mode : 'error',
    (): UpdaterMode => 'error',
  );
  return policy;
}

export async function requireNativeUpdater(): Promise<void> {
  if (await getUpdaterMode() !== 'native') {
    throw new Error('La actualización automática no está disponible en este modo.');
  }
}
