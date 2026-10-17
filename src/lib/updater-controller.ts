import { updateErrorText, type UpdateInfo, type UpdatePhase } from './updater';
import type { UpdaterMode } from './updater-policy';

/** Dependencias del ciclo de actualización, con costuras para probarlo sin Tauri. */
export interface UpdaterControllerDeps {
  /** Comprueba si hay versión nueva. */
  check: () => Promise<UpdateInfo | null>;
  /** Descarga e instala, informando del progreso. */
  install: (onProgress: (pct: number | null) => void) => Promise<void>;
  /** Suscribe al aviso de la tira; devuelve la baja. */
  listen: (handler: (info: UpdateInfo) => void) => Promise<() => void>;
}

export interface UpdaterController {
  getState(): UpdatePhase;
  subscribe(listener: (state: UpdatePhase) => void): () => void;
  /** Arranca el ciclo y la escucha; simétrico con stop() para StrictMode. */
  start(): void;
  /** Lo detiene y descarta resultados pendientes; reversible volviendo a start(). */
  stop(): void;
  /** `silent`: sin «buscando…» ni errores a la vista (segundo plano). */
  check(silent?: boolean): Promise<void>;
  install(): Promise<void>;
}

/** Ciclo de Ajustes: sin política nativa no escucha avisos ni activa acciones. */
export function startUpdaterSession(controller: UpdaterController, mode: UpdaterMode, auto: boolean): () => void {
  if (mode !== 'native') return () => {};
  controller.start();
  if (auto) void controller.check(true);
  return () => controller.stop();
}

/** Acepta solo payloads con una versión utilizable; el resto se ignora. */
function normalizeInfo(value: unknown): UpdateInfo | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o.version !== 'string' || o.version.length === 0) return null;
  return {
    version: o.version,
    notes: typeof o.notes === 'string' ? o.notes : null,
    date: typeof o.date === 'string' ? o.date : null,
  };
}

export function createUpdaterController(deps: UpdaterControllerDeps): UpdaterController {
  let state: UpdatePhase = { phase: 'idle' };
  let active = false;
  // Cada parada sube la generación: los resultados en vuelo de antes se descartan.
  let generation = 0;
  let checkInFlight = false;
  let unlisten: (() => void) | null = null;
  let listenerTicket: object | null = null;
  const listeners = new Set<(state: UpdatePhase) => void>();

  // Función auxiliar: evita que un guard previo estreche el tipo de `state`
  // para el resto de la función (el estado puede cambiar durante un await).
  const isInstalling = () => state.phase === 'installing';

  const publish = (next: UpdatePhase) => {
    state = next;
    for (const listener of [...listeners]) listener(state);
  };

  const offer = (raw: unknown) => {
    if (!active || isInstalling()) return;
    const info = normalizeInfo(raw);
    if (info) publish({ phase: 'available', info });
  };

  const stop = () => {
    if (!active) return;
    active = false;
    generation += 1;
    checkInFlight = false;
    listenerTicket = null;
    const off = unlisten;
    unlisten = null;
    if (off) {
      try {
        off();
      } catch {
        /* la baja ya no es válida */
      }
    }
  };

  const start = () => {
    if (active) return;
    active = true;
    const ticket = {};
    listenerTicket = ticket;
    deps.listen((info) => {
      if (active && listenerTicket === ticket) offer(info);
    }).then(
      (off) => {
        if (active && listenerTicket === ticket) unlisten = off;
        else {
          try {
            off();
          } catch {
            /* nada que dar de baja */
          }
        }
      },
      () => {
        /* Un fallo al registrar el oyente no debe romper la comprobación manual. */
      },
    );
  };

  const check = async (silent = false) => {
    if (!active || isInstalling() || checkInFlight) return;
    const gen = generation;
    checkInFlight = true;
    if (!silent) publish({ phase: 'checking' });
    try {
      const info = await deps.check();
      if (!active || gen !== generation || isInstalling()) return;
      if (info) publish({ phase: 'available', info });
      else if (!silent) publish({ phase: 'none', checkedAt: Date.now() });
    } catch (e) {
      if (!active || gen !== generation || isInstalling()) return;
      if (!silent) publish({ phase: 'error', message: updateErrorText(e) });
    } finally {
      if (gen === generation) checkInFlight = false;
    }
  };

  const install = async () => {
    if (!active || state.phase !== 'available') return;
    const info = state.info;
    const gen = generation;
    publish({ phase: 'installing', info, progress: null });
    try {
      await deps.install((progress) => {
        if (!active || gen !== generation || state.phase !== 'installing') return;
        publish({ phase: 'installing', info, progress });
      });
    } catch (e) {
      if (!active || gen !== generation) return;
      publish({ phase: 'error', message: updateErrorText(e) });
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    stop,
    check,
    install,
  };
}
