/**
 * Controlador del check «Arrancar al iniciar sesión». La base confirmada la da
 * siempre una lectura real del sistema operativo: aplicar no basta, hay que
 * leer de vuelta y comprobar que coincide antes de dar el valor por bueno.
 */

/** Costuras con el plugin de autostart; los tests sustituyen estas funciones. */
export interface AutostartControllerDeps {
  /** Lee el estado real del sistema. */
  read: () => Promise<boolean>;
  /** Activa el arranque automático en el sistema. */
  enable: () => Promise<void>;
  /** Lo desactiva. */
  disable: () => Promise<void>;
}

export interface AutostartState {
  /** Base confirmada por el sistema; `null` mientras no se conozca. */
  confirmed: boolean | null;
  /** Hay una lectura o una aplicación en curso. */
  busy: boolean;
  /** Último error visible; `null` si no hay. */
  error: string | null;
}

export type AutostartApplyOutcome =
  | { ok: true; confirmed: boolean; skipped: boolean }
  | { ok: false; stage: 'busy' | 'unknown' | 'apply' | 'readback' | 'mismatch'; message: string };

export interface AutostartController {
  getState(): AutostartState;
  subscribe(listener: (state: AutostartState) => void): () => void;
  /** Arranca la lectura inicial; simétrico con `stop()` para StrictMode. */
  start(): void;
  /** Lo detiene y descarta resultados en vuelo. */
  stop(): void;
  /** Relanza la lectura (reintento visible); ignora solapamientos. */
  load(): Promise<void>;
  /** Aplica el valor deseado y lo confirma leyendo de vuelta. */
  apply(desired: boolean): Promise<AutostartApplyOutcome>;
}

/** Mensaje legible de cualquier rechazo. */
function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error && e.message) return e.message;
  return String(e);
}

const describeState = (value: boolean) => (value ? 'activado' : 'desactivado');

/** El sistema quedó en un valor distinto al pedido: no se confirma el pedido. */
function mismatchMessage(desired: boolean, actual: boolean): string {
  return `El sistema quedó en «${describeState(actual)}» en vez de «${describeState(desired)}».`;
}

export function createAutostartController(deps: AutostartControllerDeps): AutostartController {
  let state: AutostartState = { confirmed: null, busy: false, error: null };
  let active = false;
  // Cada parada sube la generación: los resultados en vuelo de antes se descartan.
  let generation = 0;
  let inFlight = false;
  const listeners = new Set<(state: AutostartState) => void>();

  const update = (patch: Partial<AutostartState>) => {
    state = { ...state, ...patch };
    // Tras `stop()` no se avisa a nadie: el componente ya no está.
    if (!active) return;
    for (const listener of [...listeners]) listener(state);
  };

  const load = async () => {
    if (!active || inFlight) return;
    const gen = generation;
    inFlight = true;
    update({ busy: true, error: null });
    try {
      const confirmed = await deps.read();
      // Una parada o una lectura más nueva invalidan este resultado.
      if (!active || gen !== generation) return;
      update({ confirmed, busy: false, error: null });
    } catch (e) {
      if (!active || gen !== generation) return;
      update({ confirmed: null, busy: false, error: errorText(e) });
    } finally {
      if (gen === generation) inFlight = false;
    }
  };

  const apply = async (desired: boolean): Promise<AutostartApplyOutcome> => {
    if (!active || inFlight) return { ok: false, stage: 'busy', message: 'Hay una operación en curso.' };
    if (state.confirmed === null) {
      return { ok: false, stage: 'unknown', message: 'No se conoce el estado de inicio al iniciar sesión. Reintenta la lectura.' };
    }
    // Sin cambios reales no se llama al sistema.
    if (state.confirmed === desired) return { ok: true, confirmed: desired, skipped: true };

    const gen = generation;
    inFlight = true;
    update({ busy: true, error: null });
    try {
      if (desired) await deps.enable();
      else await deps.disable();
    } catch (e) {
      if (!active || gen !== generation) return { ok: false, stage: 'busy', message: errorText(e) };
      inFlight = false;
      // El fallo al aplicar no cambia la base: el borrador sigue siendo recuperable.
      update({ busy: false, error: errorText(e) });
      return { ok: false, stage: 'apply', message: errorText(e) };
    }

    // Si se paró durante el enable/disable, no se lee de vuelta ni se confirma.
    if (!active || gen !== generation) return { ok: false, stage: 'busy', message: 'Operación cancelada.' };

    // Aplicado, pero aún no confirmado: la base solo avanza si la lectura coincide.
    try {
      const actual = await deps.read();
      if (!active || gen !== generation) return { ok: false, stage: 'busy', message: 'Operación cancelada.' };
      inFlight = false;
      if (actual === desired) {
        update({ confirmed: actual, busy: false, error: null });
        return { ok: true, confirmed: actual, skipped: false };
      }
      // Se leyó bien: la base es la real, aunque no sea lo pedido.
      update({ confirmed: actual, busy: false, error: mismatchMessage(desired, actual) });
      return { ok: false, stage: 'mismatch', message: mismatchMessage(desired, actual) };
    } catch (e) {
      if (!active || gen !== generation) return { ok: false, stage: 'busy', message: errorText(e) };
      inFlight = false;
      // Aplicado pero sin poder leer: base desconocida, sin deshacer a ciegas.
      update({ confirmed: null, busy: false, error: errorText(e) });
      return { ok: false, stage: 'readback', message: errorText(e) };
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (active) return;
      active = true;
      void load();
    },
    stop() {
      if (!active) return;
      active = false;
      generation += 1;
      inFlight = false;
      state = { ...state, busy: false };
    },
    load,
    apply,
  };
}
