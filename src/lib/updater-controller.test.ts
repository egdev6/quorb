import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));

import { createUpdaterController, startUpdaterSession, type UpdaterControllerDeps } from './updater-controller';
import type { UpdateInfo, UpdatePhase } from './updater';

const info = (version = '0.2.0'): UpdateInfo => ({ version, notes: null, date: null });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(overrides: Partial<UpdaterControllerDeps> = {}) {
  const deps: UpdaterControllerDeps = {
    check: vi.fn(async () => null),
    install: vi.fn(async () => {}),
    listen: vi.fn(async () => () => {}),
    ...overrides,
  };
  return { controller: createUpdaterController(deps), deps };
}

describe('updater controller', () => {
  it.each(['unknown', 'manual', 'error', 'native'] as const)('gates the Settings lifecycle on backend mode: %s', async (mode) => {
    const { controller, deps } = setup({ check: vi.fn(async () => info()) });
    const stop = startUpdaterSession(controller, mode, true);
    await flush();
    await controller.check();
    await controller.install();
    const native = mode === 'native';
    expect(deps.listen).toHaveBeenCalledTimes(native ? 1 : 0);
    expect(deps.check).toHaveBeenCalledTimes(native ? 2 : 0);
    expect(deps.install).toHaveBeenCalledTimes(native ? 1 : 0);
    stop();
    await controller.check();
    expect(deps.check).toHaveBeenCalledTimes(native ? 2 : 0);
  });

  it('allows native manual actions with automatic checks disabled', async () => {
    const { controller, deps } = setup({ check: vi.fn(async () => info()) });
    const stop = startUpdaterSession(controller, 'native', false);
    expect(deps.check).not.toHaveBeenCalled();
    await controller.check();
    expect(controller.getState()).toEqual({ phase: 'available', info: info() });
    stop();
  });

  it('shows none after a manual check that finds nothing', async () => {
    const { controller } = setup();
    controller.start();
    await controller.check();
    expect(controller.getState()).toMatchObject({ phase: 'none' });
  });

  it('shows a manual failure as a visible error', async () => {
    const { controller } = setup({ check: vi.fn(async () => Promise.reject(new Error('network dns error'))) });
    controller.start();
    await controller.check();
    const state = controller.getState();
    expect(state).toMatchObject({ phase: 'error' });
    if (state.phase === 'error') expect(state.message).toMatch(/conexión/);
  });

  it('keeps a silent failure from erasing an offered update', async () => {
    let calls = 0;
    const check = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve(info()) : Promise.reject(new Error('boom'));
    });
    const { controller } = setup({ check });
    controller.start();
    await controller.check();
    await controller.check(true);
    expect(controller.getState()).toEqual({ phase: 'available', info: info() });
  });

  it('updates to available from a strip event without a manual check', async () => {
    let handler: ((value: UpdateInfo) => void) | null = null;
    const { controller } = setup({
      listen: vi.fn(async (h: (value: UpdateInfo) => void) => {
        handler = h;
        return () => {};
      }),
    });
    controller.start();
    handler!(info('0.3.0'));
    expect(controller.getState()).toEqual({ phase: 'available', info: info('0.3.0') });
  });

  it('ignores malformed event payloads', async () => {
    let handler: ((value: unknown) => void) | null = null;
    const { controller } = setup({
      listen: vi.fn(async (h: (value: UpdateInfo) => void) => {
        handler = h as (value: unknown) => void;
        return () => {};
      }),
    });
    controller.start();
    handler!({ foo: 'bar' });
    handler!({ version: '' });
    handler!(null);
    expect(controller.getState()).toEqual({ phase: 'idle' });
  });

  it('never lets an event clobber an install in progress', async () => {
    let handler: ((value: UpdateInfo) => void) | null = null;
    const pending = deferred<void>();
    const { controller } = setup({
      check: vi.fn(async () => info()),
      install: vi.fn(() => pending.promise),
      listen: vi.fn(async (h: (value: UpdateInfo) => void) => {
        handler = h;
        return () => {};
      }),
    });
    controller.start();
    await controller.check();
    const installing = controller.install();
    handler!(info('0.9.0'));
    expect(controller.getState()).toMatchObject({ phase: 'installing', info: info() });
    pending.resolve();
    await installing;
  });

  it('never lets a late silent check clobber an install in progress', async () => {
    const late = deferred<UpdateInfo | null>();
    let calls = 0;
    const check = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve(info()) : late.promise;
    });
    const pending = deferred<void>();
    const { controller } = setup({ check, install: vi.fn(() => pending.promise) });
    controller.start();
    await controller.check();
    const silent = controller.check(true);
    const installing = controller.install();
    late.resolve(info('0.9.0'));
    await silent;
    expect(controller.getState()).toMatchObject({ phase: 'installing', info: info() });
    pending.resolve();
    await installing;
  });

  it('guards against overlapping checks', async () => {
    const pending = deferred<UpdateInfo | null>();
    const check = vi.fn(() => pending.promise);
    const { controller } = setup({ check });
    controller.start();
    const first = controller.check();
    const second = controller.check();
    expect(check).toHaveBeenCalledTimes(1);
    pending.resolve(null);
    await Promise.all([first, second]);
  });

  it('guards against overlapping installs', async () => {
    const pending = deferred<void>();
    const install = vi.fn(() => pending.promise);
    const { controller } = setup({ check: vi.fn(async () => info()), install });
    controller.start();
    await controller.check();
    const first = controller.install();
    const second = controller.install();
    expect(install).toHaveBeenCalledTimes(1);
    pending.resolve();
    await Promise.all([first, second]);
  });

  it('prevents a late check from updating state after unmount', async () => {
    const pending = deferred<UpdateInfo | null>();
    const { controller } = setup({ check: vi.fn(() => pending.promise) });
    const states: UpdatePhase[] = [];
    controller.subscribe((state) => states.push(state));
    controller.start();
    const check = controller.check(true);
    controller.stop();
    pending.resolve(info());
    await check;
    expect(controller.getState()).toEqual({ phase: 'idle' });
    expect(states).toEqual([]);
  });

  it('cleans up a listener that resolves after unmount', async () => {
    const pending = deferred<() => void>();
    const off = vi.fn();
    const { controller } = setup({ listen: vi.fn(() => pending.promise) });
    controller.start();
    controller.stop();
    pending.resolve(off);
    await flush();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('survives a rejected listener registration', async () => {
    const { controller } = setup({ listen: vi.fn(async () => Promise.reject(new Error('no window'))) });
    controller.start();
    await flush();
    expect(controller.getState()).toEqual({ phase: 'idle' });
  });

  it('shows a rejected install instead of a fake completion', async () => {
    const { controller } = setup({
      check: vi.fn(async () => info()),
      install: vi.fn(async () => Promise.reject(new Error('signature verification failed'))),
    });
    controller.start();
    await controller.check();
    await controller.install();
    const state = controller.getState();
    expect(state).toMatchObject({ phase: 'error' });
    if (state.phase === 'error') expect(state.message).toMatch(/firma/);
  });

  it('reports install progress while installing', async () => {
    const { controller } = setup({
      check: vi.fn(async () => info()),
      install: vi.fn(async (onProgress: (pct: number | null) => void) => {
        onProgress(42);
      }),
    });
    controller.start();
    await controller.check();
    await controller.install();
    expect(controller.getState()).toEqual({ phase: 'installing', info: info(), progress: 42 });
  });

  it('offers an update found during a silent check', async () => {
    const { controller } = setup({ check: vi.fn(async () => info('0.4.0')) });
    const states: UpdatePhase[] = [];
    controller.subscribe((state) => states.push(state));
    controller.start();
    await controller.check(true);
    expect(controller.getState()).toEqual({ phase: 'available', info: info('0.4.0') });
    expect(states).toEqual([{ phase: 'available', info: info('0.4.0') }]);
  });

  it('ignores events and checks once stopped', async () => {
    let handler: ((value: UpdateInfo) => void) | null = null;
    const check = vi.fn(async () => info());
    const { controller } = setup({
      check,
      listen: vi.fn(async (h: (value: UpdateInfo) => void) => {
        handler = h;
        return () => {};
      }),
    });
    controller.start();
    controller.stop();
    handler!(info('0.9.0'));
    await controller.check();
    expect(check).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({ phase: 'idle' });
  });

  it('can be restarted after a stop (React StrictMode setup/cleanup/setup)', async () => {
    const { controller } = setup({ check: vi.fn(async () => info()) });
    controller.start();
    controller.stop();
    controller.start();
    await controller.check();
    expect(controller.getState()).toEqual({ phase: 'available', info: info() });
  });
});
