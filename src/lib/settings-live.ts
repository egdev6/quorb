import type { AppConfig } from './types';

// Autosave vivo de personalización (#97): tamaño, color y los seis controles
// inmediatos (opacidad, círculos pequeños, borde, posición, auto-ocultar y
// siempre encima). Cada cambio se envía por la misma vía de patch atómico del
// backend y, si falla, queda como error recuperable con reintento del mismo
// patch: nunca se presenta un éxito falso ni se recurre a un snapshot completo
// que pueda pisar cuentas o un arrastre concurrente.

/** Resultado canónico del backend al aplicar un patch vivo. */
export interface LiveSaveOutcome {
  /** Config ya persistida (autoridad de sanitize/persist del backend). */
  config: AppConfig;
  /** Fallo del efecto nativo (p. ej. «siempre encima»): persistido pero no aplicado. */
  nativeError?: string | null;
}

export type LiveSave = (patch: Partial<AppConfig>) => Promise<LiveSaveOutcome>;

export interface LiveState {
  /** Hay un envío en vuelo. */
  saving: boolean;
  /** Último error recuperable (fallo de guardado o efecto nativo). */
  error: string | null;
  /** Queda trabajo por enviar (pendiente o en vuelo). */
  pending: boolean;
}

export interface LiveSaverOptions {
  /** Milisegundos de agrupación antes de enviar. */
  delay: number;
  save: LiveSave;
  /** Config canónica ya persistida (se adopta aunque el efecto nativo falle). */
  onSaved?: (config: AppConfig, patch: Partial<AppConfig>) => void;
}

export interface LiveSaver {
  /** Acumula un cambio y programa el envío agrupado. */
  push(patch: Partial<AppConfig>): void;
  /** Envía todo lo pendiente (y lo encadenado) y espera. Rechaza si algo queda sin resolver. */
  flush(): Promise<void>;
  /** Reenvía solo los campos cuyo último intento falló. */
  retry(): Promise<void>;
  /** ¿Queda trabajo por enviar o en vuelo? */
  hasPending(): boolean;
  /** ¿Hay fallos por campo sin resolver (pendientes de reintento)? */
  hasUnresolved(): boolean;
  /** Valores canónicos confirmados por el backend para los campos vivos. */
  latestLive(): Partial<AppConfig>;
  getState(): LiveState;
  subscribe(listener: (state: LiveState) => void): () => void;
  /** Cancela el debounce y deja de notificar. No envía (el cierre lo maneja flush). */
  dispose(): void;
}

type CloseSaver = Pick<LiveSaver, 'hasPending' | 'hasUnresolved' | 'flush'>;

/** La X y Cerrar comparten el mismo manejo de trabajo vivo pendiente. */
export function createLiveCloseHandler(getLive: () => CloseSaver | null, close: () => Promise<void>) {
  let phase: 'idle' | 'flushing' | 'closing' = 'idle';
  return async (event: { preventDefault(): void }): Promise<void> => {
    if (phase === 'flushing') { event.preventDefault(); return; }
    const live = getLive();
    // Permite el cierre nativo recursivo una vez guardado todo.
    if (!live || (!live.hasPending() && !live.hasUnresolved())) return;
    event.preventDefault();
    if (phase === 'closing') return;
    phase = 'flushing';
    try {
      await live.flush();
      if (getLive() !== live || live.hasPending() || live.hasUnresolved()) return;
      phase = 'closing';
      await close();
    } catch {
      // Se conserva la ventana y la recuperación del autosave.
    } finally {
      phase = 'idle';
    }
  };
}

/** Mensaje legible de cualquier rechazo. */
function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error && e.message) return e.message;
  return String(e);
}

export function createLiveSaver(options: LiveSaverOptions): LiveSaver {
  let pending: Partial<AppConfig> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let inFlight = 0;
  // Fallo por campo: un error de «siempre encima» no se borra porque otro campo
  // viva guarde bien; cada campo se reintenta con su último valor fallido.
  const failures = new Map<keyof AppConfig, { value: unknown; message: string }>();
  // Canónico confirmado por el backend, para no reenviar valores viejos de otros
  // campos en un guardado completo posterior.
  const canonical: Partial<AppConfig> = {};
  let disposed = false;
  const listeners = new Set<(state: LiveState) => void>();
  let state: LiveState = { saving: false, error: null, pending: false };

  const hasPending = () => Object.keys(pending).length > 0 || inFlight > 0;
  const firstFailureMessage = () => {
    for (const failure of failures.values()) return failure.message;
    return null;
  };

  const syncState = () => {
    if (disposed) return;
    state = { saving: inFlight > 0, pending: hasPending(), error: firstFailureMessage() };
    for (const listener of listeners) listener(state);
  };

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /** Consume lo pendiente y lo encadena tras el envío anterior (nunca en paralelo). */
  function dispatch(): void {
    clearTimer();
    if (Object.keys(pending).length === 0) return;
    const patch = { ...pending };
    pending = {};
    inFlight++;
    syncState();
    const run = chain.then(async () => {
      try {
        const outcome = await options.save(patch);
        const keys = Object.keys(patch) as (keyof AppConfig)[];
        for (const key of keys) canonical[key] = outcome.config[key] as never;
        for (const key of keys) {
          // Solo el efecto nativo de «siempre encima» puede fallar tras persistir.
          if (key === 'alwaysOnTop' && outcome.nativeError) failures.set(key, { value: patch[key], message: outcome.nativeError });
          else failures.delete(key);
        }
        options.onSaved?.(outcome.config, patch);
      } catch (e) {
        const message = errorText(e);
        for (const key of Object.keys(patch) as (keyof AppConfig)[]) failures.set(key, { value: patch[key], message });
        throw e;
      } finally {
        inFlight--;
        syncState();
      }
    });
    // La cadena sobrevive al fallo; `run` se propaga a quien espera el flush.
    chain = run.catch(() => {});
  }

  async function flush(): Promise<void> {
    // Espera a que no quede trabajo: cubre el envío en vuelo y lo encolado
    // mientras tanto, no solo el mapa pendiente del instante de la llamada.
    for (;;) {
      dispatch();
      if (inFlight === 0) break;
      await chain;
    }
    if (failures.size > 0) throw new Error(firstFailureMessage() ?? 'No se pudo guardar el cambio');
  }

  return {
    push(patch) {
      if (disposed) return;
      pending = { ...pending, ...patch };
      // Un valor nuevo sustituye el fallo previo del mismo campo.
      for (const key of Object.keys(patch) as (keyof AppConfig)[]) failures.delete(key);
      syncState();
      clearTimer();
      timer = setTimeout(() => {
        timer = undefined;
        void flush().catch(() => {});
      }, options.delay);
    },
    flush,
    async retry() {
      if (disposed) return;
      // Dejar que el valor más nuevo en vuelo resuelva antes de elegir qué falló.
      await flush().catch(() => {});
      if (failures.size === 0) return;
      const patch: Partial<AppConfig> = {};
      for (const [key, failure] of failures) patch[key] = failure.value as never;
      pending = { ...patch, ...pending };
      syncState();
      await flush();
    },
    hasPending,
    hasUnresolved: () => failures.size > 0,
    latestLive: () => ({ ...canonical }),
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      clearTimer();
      disposed = true;
      listeners.clear();
    },
  };
}
