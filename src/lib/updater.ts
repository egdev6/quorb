// Actualizaciones desde GitHub Releases (tauri-plugin-updater, firmadas con minisign).
import { emit } from '@tauri-apps/api/event';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { requireNativeUpdater, type UpdaterMode } from './updater-policy';

/** Cada cuánto se vuelve a mirar si hay versión nueva. */
export const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
/** Primera comprobación tras arrancar (no compite con la primera carga de datos). */
export const UPDATE_FIRST_DELAY_MS = 20_000;

/** No crea temporizadores hasta que el backend autoriza el updater nativo. */
export function startUpdatePolling(mode: UpdaterMode, run: () => void): () => void {
  if (mode !== 'native') return () => {};
  const first = globalThis.setTimeout(run, UPDATE_FIRST_DELAY_MS);
  const every = globalThis.setInterval(run, UPDATE_EVERY_MS);
  return () => {
    globalThis.clearTimeout(first);
    globalThis.clearInterval(every);
  };
}

export interface UpdateInfo {
  version: string;
  notes: string | null;
  date: string | null;
}

export type UpdatePhase =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'none'; checkedAt: number }
  | { phase: 'available'; info: UpdateInfo }
  | { phase: 'installing'; info: UpdateInfo; progress: number | null }
  | { phase: 'error'; message: string };

/** Canales con los que la tira comparte lo que descubre con Ajustes. */
export const UPDATE_EVENTS = {
  available: 'quorb://update-available',
} as const;

/** Avisa de una versión nueva sin que un fallo de emisión rompa el sondeo ni el estado local. */
export async function emitUpdateAvailable(info: UpdateInfo): Promise<void> {
  try {
    await emit(UPDATE_EVENTS.available, info);
  } catch {
    /* la ventana receptora puede no estar abierta */
  }
}

let pending: Update | null = null;

/** Devuelve la versión nueva o null si ya estás al día. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  await requireNativeUpdater();
  const update = await check({ timeout: 30_000 });
  pending = update;
  if (!update) return null;
  return { version: update.version, notes: update.body?.trim() || null, date: update.date ?? null };
}

/**
 * Descarga, verifica la firma e instala. En Windows el instalador cierra la app
 * y la vuelve a abrir; en el resto se reinicia aquí.
 */
export async function installUpdate(onProgress: (pct: number | null) => void): Promise<void> {
  await requireNativeUpdater();
  const update = pending ?? (await check({ timeout: 30_000 }));
  if (!update) throw new Error('No hay ninguna actualización pendiente.');
  let total = 0;
  let done = 0;
  await update.downloadAndInstall((ev) => {
    if (ev.event === 'Started') {
      total = ev.data.contentLength ?? 0;
      onProgress(total ? 0 : null);
    } else if (ev.event === 'Progress') {
      done += ev.data.chunkLength;
      onProgress(total ? progressPct(done, total) : null);
    } else if (ev.event === 'Finished') {
      onProgress(100);
    }
  });
  await relaunch();
}

export function progressPct(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/** Mensaje legible para los errores típicos del updater. */
export function updateErrorText(e: unknown): string {
  const raw = String((e as { message?: string })?.message ?? e);
  if (/signature/i.test(raw)) return 'La firma de la actualización no es válida; no se ha instalado.';
  if (/pubkey|public key/i.test(raw)) return 'Falta la clave pública del updater en tauri.conf.json.';
  if (/404|not found|release JSON/i.test(raw)) return 'Aún no hay ninguna release publicada.';
  if (/network|dns|timed? ?out|connect/i.test(raw)) return 'Sin conexión con GitHub. Se reintentará más tarde.';
  return raw;
}

/** Avisar una sola vez por versión (recordado en este equipo). */
export function shouldNotifyUpdate(version: string, store: Pick<Storage, 'getItem' | 'setItem'> | null): boolean {
  try {
    if (!store || store.getItem('notifiedUpdate') === version) return false;
    store.setItem('notifiedUpdate', version);
    return true;
  } catch {
    return false;
  }
}
