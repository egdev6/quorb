import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from './types';
import { createLiveCloseHandler, createLiveSaver, type LiveSave, type LiveSaveOutcome } from './settings-live';

const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ opacity: 0.94, compact: false, orbSize: 48, accentColor: '#ff0036', dockEdge: 'top', dockOffset: 0.5, autoHide: false, alwaysOnTop: true, ...over }) as unknown as AppConfig;

const ok = (config: AppConfig, nativeError: string | null = null): LiveSaveOutcome => ({ config, nativeError });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createLiveSaver (autosave vivo de #97)', () => {
  it('coalesces several pushes inside the debounce into one save', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (patch: Partial<AppConfig>) => ok(cfg(patch)));
    const live = createLiveSaver({ delay: 120, save });
    live.push({ opacity: 0.5 });
    live.push({ compact: true });
    live.push({ dockEdge: 'left' });
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ opacity: 0.5, compact: true, dockEdge: 'left' });
    expect(live.hasPending()).toBe(false);
  });

  it('flush sends the pending patch immediately and awaits it (last change not lost)', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (patch: Partial<AppConfig>) => ok(cfg(patch)));
    const live = createLiveSaver({ delay: 120, save });
    live.push({ autoHide: true });
    await live.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ autoHide: true });
    expect(live.hasPending()).toBe(false);
  });

  it('flush is a no-op without pending changes', async () => {
    const save = vi.fn(async (patch: Partial<AppConfig>) => ok(cfg(patch)));
    const live = createLiveSaver({ delay: 120, save });
    await live.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it('serializes a push made while a save is in flight', async () => {
    vi.useFakeTimers();
    let release!: (value: LiveSaveOutcome) => void;
    const save = vi.fn(
      (patch: Partial<AppConfig>) =>
        new Promise<LiveSaveOutcome>((resolve) => {
          release = (value) => resolve(value);
          // La primera promesa queda pendiente hasta que el test la libere.
          void patch;
        }),
    );
    const live = createLiveSaver({ delay: 120, save });
    live.push({ opacity: 0.5 });
    await vi.advanceTimersByTimeAsync(120);
    expect(save).toHaveBeenCalledTimes(1);
    live.push({ compact: true });
    await vi.advanceTimersByTimeAsync(120);
    // No se solapa: la segunda espera a que termine la primera.
    expect(save).toHaveBeenCalledTimes(1);
    release(ok(cfg({ opacity: 0.5 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ compact: true });
  });

  it('reports the canonical config through onSaved', async () => {
    vi.useFakeTimers();
    const saved = cfg({ opacity: 0.5 });
    const save = vi.fn(async () => ok(saved));
    const onSaved = vi.fn();
    const live = createLiveSaver({ delay: 120, save, onSaved });
    live.push({ opacity: 0.5 });
    await vi.advanceTimersByTimeAsync(120);
    expect(onSaved).toHaveBeenCalledWith(saved, { opacity: 0.5 });
  });

  it('keeps a recoverable error and retries the exact failed patch', async () => {
    vi.useFakeTimers();
    const save = vi.fn<LiveSave>(async () => {
      throw new Error('backend caído');
    });
    const live = createLiveSaver({ delay: 120, save });
    live.push({ alwaysOnTop: false });
    await expect(live.flush().catch((e: unknown) => e)).resolves.toBeInstanceOf(Error);
    expect(live.getState().error).toContain('backend caído');
    save.mockResolvedValueOnce(ok(cfg({ alwaysOnTop: false })));
    await live.retry();
    expect(save).toHaveBeenLastCalledWith({ alwaysOnTop: false });
    expect(live.getState().error).toBeNull();
  });

  it('exposes a native partial failure without pretending success and retries it', async () => {
    vi.useFakeTimers();
    const save = vi
      .fn<(patch: Partial<AppConfig>) => Promise<LiveSaveOutcome>>()
      .mockResolvedValueOnce(ok(cfg({ alwaysOnTop: true }), 'No se pudo aplicar «siempre encima»'))
      .mockResolvedValueOnce(ok(cfg({ alwaysOnTop: true })));
    const onSaved = vi.fn();
    const live = createLiveSaver({ delay: 120, save, onSaved });
    live.push({ alwaysOnTop: true });
    await expect(live.flush()).rejects.toThrow('siempre encima');
    // La config quedó persistida (se adopta el canónico) pero el efecto nativo falló.
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(live.getState().error).toContain('siempre encima');
    await live.retry();
    expect(save).toHaveBeenLastCalledWith({ alwaysOnTop: true });
    expect(live.getState().error).toBeNull();
  });

  it('notifies subscribers of state changes', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ok(cfg()));
    const live = createLiveSaver({ delay: 120, save });
    const seen: boolean[] = [];
    const off = live.subscribe((s) => seen.push(s.saving));
    live.push({ compact: true });
    await vi.advanceTimersByTimeAsync(120);
    off();
    expect(seen).toContain(true);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it('stops scheduling and ignores pushes after dispose', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ok(cfg()));
    const live = createLiveSaver({ delay: 120, save });
    live.push({ opacity: 0.5 });
    live.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(save).not.toHaveBeenCalled();
    live.push({ compact: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('createLiveSaver — fallos del revisor (B1–B4)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('B1: hasPending sigue true con un envío en vuelo y flush espera lo encolado', async () => {
    let releaseA!: () => void;
    const calls: Partial<AppConfig>[] = [];
    const save: LiveSave = (patch) => {
      calls.push(patch);
      if (calls.length === 1) return new Promise((resolve) => { releaseA = () => resolve(ok(cfg(patch as AppConfig))); });
      return Promise.resolve(ok(cfg(patch as AppConfig)));
    };
    const live = createLiveSaver({ delay: 0, save });
    live.push({ opacity: 0.5 });
    await new Promise((r) => setTimeout(r, 5)); // A ya dispatchado, en vuelo
    expect(calls).toEqual([{ opacity: 0.5 }]);
    expect(live.hasPending()).toBe(true); // antes era false mientras A estaba en vuelo
    live.push({ compact: true });          // B queda encolado durante A
    expect(live.hasPending()).toBe(true);
    const flushed = live.flush();
    releaseA();
    await flushed;
    expect(calls).toEqual([{ opacity: 0.5 }, { compact: true }]);
    expect(live.hasPending()).toBe(false);
  });

  it('B2: un fallo nativo de un campo sobrevive al éxito de otro campo', async () => {
    const save = vi.fn<LiveSave>(async (patch) =>
      'alwaysOnTop' in patch ? ok(cfg(patch as AppConfig), 'top no aplicado') : ok(cfg(patch as AppConfig)),
    );
    const live = createLiveSaver({ delay: 0, save });
    live.push({ alwaysOnTop: true });
    await expect(live.flush()).rejects.toThrow('top no aplicado');
    expect(live.hasUnresolved()).toBe(true);
    // Otro campo guarda bien: no debe borrar el fallo de siempre encima.
    live.push({ opacity: 0.4 });
    await live.flush().catch(() => {});
    expect(live.hasUnresolved()).toBe(true);
    save.mockResolvedValue(ok(cfg()));
    await live.retry();
    // El reintento reenvía solo el campo fallido, con su último valor.
    expect(save).toHaveBeenLastCalledWith({ alwaysOnTop: true });
    expect(live.hasUnresolved()).toBe(false);
  });

  it('B2b: un fallo de persistencia se reintenta solo por el subconjunto fallido', async () => {
    const save = vi.fn<LiveSave>().mockRejectedValueOnce(new Error('disco')).mockResolvedValue(ok(cfg()));
    const live = createLiveSaver({ delay: 0, save });
    live.push({ compact: true });
    await expect(live.flush()).rejects.toThrow('disco');
    expect(live.hasUnresolved()).toBe(true);
    await live.retry();
    expect(save).toHaveBeenLastCalledWith({ compact: true });
    expect(live.hasUnresolved()).toBe(false);
  });

  it('B3: un saver recreado tras dispose vuelve a guardar y el viejo queda muerto', async () => {
    const save = vi.fn<LiveSave>(async (patch) => ok(cfg(patch as AppConfig)));
    const first = createLiveSaver({ delay: 0, save });
    first.dispose();
    first.push({ opacity: 0.2 });
    await new Promise((r) => setTimeout(r, 5));
    expect(save).not.toHaveBeenCalled();
    const second = createLiveSaver({ delay: 0, save });
    second.push({ opacity: 0.2 });
    await new Promise((r) => setTimeout(r, 5));
    expect(save).toHaveBeenCalledWith({ opacity: 0.2 });
  });

  it('B4: flush rechaza mientras hay un fallo nativo sin resolver y resuelve tras retry', async () => {
    const save = vi
      .fn<LiveSave>()
      .mockResolvedValueOnce(ok(cfg({ alwaysOnTop: true }), 'top falló'))
      .mockResolvedValueOnce(ok(cfg({ alwaysOnTop: true })));
    const live = createLiveSaver({ delay: 0, save });
    live.push({ alwaysOnTop: true });
    await expect(live.flush()).rejects.toThrow('top falló');
    expect(live.hasUnresolved()).toBe(true);
    await live.retry();
    expect(live.hasUnresolved()).toBe(false);
    await expect(live.flush()).resolves.toBeUndefined();
  });

  it('latestLive expone solo los campos vivos confirmados por el backend', async () => {
    const save = vi.fn<LiveSave>(async (patch) => ok(cfg(patch as AppConfig)));
    const live = createLiveSaver({ delay: 0, save });
    live.push({ opacity: 0.4, compact: true });
    await live.flush();
    expect(live.latestLive()).toEqual({ opacity: 0.4, compact: true });
  });

  it('retry waits for the newer in-flight value instead of appending the older failure', async () => {
    const a = deferred<LiveSaveOutcome>(), b = deferred<LiveSaveOutcome>();
    const startedA = deferred<void>(), startedB = deferred<void>();
    const save = vi.fn<LiveSave>((patch) => {
      if (save.mock.calls.length === 1) { startedA.resolve(undefined); return a.promise; }
      if (save.mock.calls.length === 2) { startedB.resolve(undefined); return b.promise; }
      return Promise.resolve(ok(cfg(patch)));
    });
    const live = createLiveSaver({ delay: 120, save });
    live.push({ opacity: 0.1 });
    const old = live.flush().catch(() => {});
    await startedA.promise;
    live.push({ opacity: 0.9 });
    const newer = live.flush().catch(() => {});
    a.reject(new Error('disk'));
    await startedB.promise;
    const retry = live.retry();
    b.resolve(ok(cfg({ opacity: 0.9 })));
    await Promise.all([old, newer, retry]);
    expect(save.mock.calls.map(([patch]) => patch)).toEqual([{ opacity: 0.1 }, { opacity: 0.9 }]);
    expect(live.latestLive()).toEqual({ opacity: 0.9 });
    expect(live.hasUnresolved()).toBe(false);
  });
});

 describe('createLiveCloseHandler', () => {
  it('coalesces two close requests while flushing and permits the recursive native close', async () => {
    const work = deferred<void>();
    let pending = true;
    const saver = { hasPending: () => pending, hasUnresolved: () => false, flush: vi.fn(() => work.promise) };
    const recursive = { preventDefault: vi.fn() };
    let handler: ReturnType<typeof createLiveCloseHandler>;
    const close = vi.fn(async () => { await handler(recursive); });
    handler = createLiveCloseHandler(() => saver, close);
    const first = { preventDefault: vi.fn() }, second = { preventDefault: vi.fn() };
    const closing = handler(first);
    const secondClosing = handler(second);
    expect(close).not.toHaveBeenCalled();
    pending = false;
    work.resolve(undefined);
    await Promise.all([closing, secondClosing]);
    expect(saver.flush).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(recursive.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps the window open on an unresolved native failure; a later clean close is allowed', async () => {
    let failed = true;
    const close = vi.fn(async () => {});
    const saver = { hasPending: () => false, hasUnresolved: () => failed, flush: vi.fn(async () => { throw new Error('native'); }) };
    const handler = createLiveCloseHandler(() => saver, close);
    const event = { preventDefault: vi.fn() };
    await handler(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    failed = false;
    const clean = { preventDefault: vi.fn() };
    await handler(clean);
    expect(clean.preventDefault).not.toHaveBeenCalled();
  });
});
