// Lógica pura del paso de conexión de las cuentas. Sin React ni DOM: se prueba
// con dependencias inyectadas.

/**
 * La cuenta puede abrir su login solo si está persistida y sin cambios
 * pendientes: el CLI busca la configuración guardada, no el borrador.
 */
export function effectivePersisted(persisted: boolean, dirty: boolean): boolean {
  return persisted && !dirty;
}

/** Incluye la cuenta y los ajustes heredados del proveedor, sin leer credenciales. */
export function isConnectionDirty(
  account: unknown,
  savedAccount: unknown,
  provider: unknown,
  savedProvider: unknown,
  env?: { sessionEnv: unknown; wslDistro: unknown },
  savedEnv?: { sessionEnv: unknown; wslDistro: unknown },
): boolean {
  return (
    JSON.stringify(account) !== JSON.stringify(savedAccount) ||
    JSON.stringify(provider) !== JSON.stringify(savedProvider) ||
    // El ENTORNO es parte de la conexión (revisión PR #92): cambiar de
    // Windows a WSL, o de una distro a otra, sin guardar haría que el login
    // usara el entorno guardado, no el que se ve en pantalla.
    env?.sessionEnv !== savedEnv?.sessionEnv ||
    env?.wslDistro !== savedEnv?.wslDistro
  );
}

export interface PresencePollerOptions {
  /** Comprueba la presencia del fichero de sesión (no su validez). */
  exists: () => Promise<boolean>;
  /** Recibe cada resultado vigente; `null` indica fallo de sondeo. */
  onResult: (found: boolean | null) => void;
  /** Intervalo entre sondeos, en ms. Por defecto 3000. */
  intervalMs?: number;
  /** Temporizador inyectable para las pruebas (por defecto `setInterval`). */
  setInterval?: (fn: () => void, ms: number) => number;
  /** Cancelador inyectable para las pruebas (por defecto `clearInterval`). */
  clearInterval?: (handle: number) => void;
}

export interface PresencePoller {
  /** Lanza la primera comprobación y programa las siguientes. */
  start: () => void;
  /** Detiene el sondeo: descarta respuestas en vuelo y cancela el temporizador. */
  stop: () => void;
}

/**
 * Sondea la presencia del fichero de sesión mientras la cuenta está abierta.
 * Una respuesta que llega después de `stop()` (p. ej. al desmontar o al cambiar
 * de cuenta) no se notifica: evita marcar como conectada una cuenta equivocada.
 */
export function createPresencePoller(options: PresencePollerOptions): PresencePoller {
  let generation = 0;
  let running = false;
  let handle: number | undefined;
  const timer = options.setInterval ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms));
  const clear = options.clearInterval ?? ((h: number) => globalThis.clearInterval(h));
  const check = (gen: number) => {
    if (!running || gen !== generation) return;
    options
      .exists()
      .then((found) => {
        if (running && gen === generation) options.onResult(found);
      })
      // Un fallo de sondeo no puede dejar la última respuesta como verdad:
      // se notifica `null` (revisión PR #92) y la UI muestra estado desconocido.
      .catch(() => {
        if (running && gen === generation) options.onResult(null);
      });
  };
  return {
    start() {
      if (running) return;
      running = true;
      const gen = generation;
      check(gen);
      handle = timer(() => check(gen), options.intervalMs ?? 3000);
    },
    stop() {
      running = false;
      generation += 1;
      if (handle !== undefined) clear(handle);
      handle = undefined;
    },
  };
}
