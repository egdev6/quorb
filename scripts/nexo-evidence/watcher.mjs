// Line-buffered watcher for the `sim_hub` transcript (#281).
//
// The fixture prints one event per line, so a chunk from the pipe can end in
// the middle of a line and an event can be split across two chunks. This keeps
// complete lines and lets a wait look only at what arrived **after a cursor**:
// a pattern that already matched earlier (the first `Registered app:`, say) must
// not satisfy a later wait, or the driver would race ahead of the app.
export function createWatcher({ timeout = 120_000 } = {}) {
  const lines = [];
  const waiters = new Set();
  let partial = '';

  const matchesSince = (from, pattern) => lines.slice(from).some((line) => pattern.test(line));

  const resolveReady = () => {
    for (const waiter of [...waiters]) {
      if (matchesSince(waiter.from, waiter.pattern)) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  };

  /** Acumula un trozo del pipe y resuelve las esperas que ya encajan. */
  const push = (chunk) => {
    partial += chunk;
    let index = partial.indexOf('\n');
    while (index !== -1) {
      lines.push(partial.slice(0, index).replace(/\r$/, ''));
      partial = partial.slice(index + 1);
      index = partial.indexOf('\n');
    }
    resolveReady();
  };

  /** Posición actual: las esperas que se registren después solo miran lo nuevo. */
  const mark = () => lines.length;

  /**
   * Espera a que aparezca una línea que case con `pattern` desde `from`.
   *
   * `from` es obligatorio en la práctica: sin él se toma el final actual, así
   * que tampoco casa con lo ya visto.
   */
  const waitFor = (pattern, label, options = {}) => {
    const from = options.from ?? lines.length;
    const ms = options.timeout ?? timeout;
    if (matchesSince(from, pattern)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { pattern, from, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timeout esperando ${label}. Transcripción:\n${lines.join('\n')}`));
      }, ms);
      waiters.add(waiter);
    });
  };

  return {
    push,
    mark,
    waitFor,
    lines,
    /** La línea incompleta que aún no ha cerrado con un salto. */
    pending: () => partial,
    text: () => lines.join('\n'),
  };
}
