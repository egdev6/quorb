import { describe, expect, it, vi } from 'vitest';
import {
  CODEX_PACKAGE,
  codexInstallActions,
  codexInstallView,
  createCodexInstallController,
  type CodexInstallDeps,
  type CodexInstallResult,
  type CodexInstallState,
  type CodexSetupStatus,
} from './codex-install';

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

/** Estado con todos los campos; evita repetir el literal en cada prueba. */
const stateFor = (patch: Partial<CodexInstallState> = {}, status: Partial<CodexSetupStatus> = {}): CodexInstallState => ({
  status: { ...baseStatus, ...status },
  reading: false,
  installing: false,
  outcome: null,
  message: null,
  error: null,
  errorFrom: null,
  ...patch,
});

const baseStatus: CodexSetupStatus = {
  supported: true,
  busy: false,
  nodeAvailable: true,
  installed: false,
  package: CODEX_PACKAGE,
  message: null,
  outcome: null,
};

function setup(overrides: Partial<CodexInstallDeps> = {}) {
  const deps: CodexInstallDeps = {
    getStatus: vi.fn(async () => ({ ...baseStatus })),
    install: vi.fn(async () => ({ outcome: 'installed', message: 'hecho' }) as CodexInstallResult),
    ...overrides,
  };
  return { controller: createCodexInstallController(deps), deps };
}

/** Arranca el controlador y espera a la primera lectura pasiva. */
async function running(overrides: Partial<CodexInstallDeps> = {}) {
  const ctx = setup(overrides);
  ctx.controller.start();
  await flush();
  ctx.controller.setVisible(true);
  await flush();
  return ctx;
}

describe('codex install controller', () => {
  it('never installs on its own when started, shown or refreshed', async () => {
    const { controller, deps } = await running();
    await controller.refresh();
    await flush();
    expect(deps.install).not.toHaveBeenCalled();
  });

  it('treats a confirmed install as the only success and rechecks the CLI once', async () => {
    const onInstalled = vi.fn();
    const install = vi.fn(async () => ({ outcome: 'installed', message: 'hecho' }) as CodexInstallResult);
    const { controller } = await running({ install, onInstalled });
    const result = await controller.requestInstall();
    expect(result).toEqual({ ok: true, outcome: 'installed' });
    expect(install).toHaveBeenCalledTimes(1);
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(codexInstallView(controller.getState())).toEqual({ kind: 'installed', justInstalled: true });
  });

  it('treats a native cancel as a valid result, not an error, and allows retry', async () => {
    const install = vi
      .fn<() => Promise<CodexInstallResult>>()
      .mockResolvedValueOnce({ outcome: 'cancelled', message: 'cancelado' })
      .mockResolvedValueOnce({ outcome: 'installed', message: 'hecho' });
    const { controller } = await running({ install });
    const first = await controller.requestInstall();
    expect(first).toEqual({ ok: true, outcome: 'cancelled' });
    expect(controller.getState().error).toBeNull();
    expect(codexInstallView(controller.getState())).toEqual({ kind: 'cancelled', justCancelled: true });
    const second = await controller.requestInstall();
    expect(second).toEqual({ ok: true, outcome: 'installed' });
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('ignores a duplicate click while an install is in flight', async () => {
    const pending = deferred<CodexInstallResult>();
    const install = vi.fn(() => pending.promise);
    const { controller } = await running({ install });
    const first = controller.requestInstall();
    const second = await controller.requestInstall();
    expect(second).toEqual({ ok: false, reason: 'in-flight', message: expect.any(String) });
    expect(install).toHaveBeenCalledTimes(1);
    pending.resolve({ outcome: 'installed', message: 'ok' });
    expect(await first).toEqual({ ok: true, outcome: 'installed' });
  });

  it('refuses to install while the backend reports another install busy', async () => {
    const { controller, deps } = await running({ getStatus: vi.fn(async () => ({ ...baseStatus, busy: true })) });
    const result = await controller.requestInstall();
    expect(result).toEqual({ ok: false, reason: 'busy', message: expect.any(String) });
    expect(deps.install).not.toHaveBeenCalled();
    expect(codexInstallView(controller.getState())).toEqual({ kind: 'busy' });
  });

  it('refuses on an unsupported platform or without Node/npm and points at manual install', async () => {
    const unsupported = await running({ getStatus: vi.fn(async () => ({ ...baseStatus, supported: false })) });
    expect(await unsupported.controller.requestInstall()).toEqual({ ok: false, reason: 'unsupported', message: expect.any(String) });
    expect(unsupported.deps.install).not.toHaveBeenCalled();
    expect(codexInstallView(unsupported.controller.getState())).toEqual({ kind: 'unsupported', package: CODEX_PACKAGE });

    const noNode = await running({ getStatus: vi.fn(async () => ({ ...baseStatus, nodeAvailable: false })) });
    expect(await noNode.controller.requestInstall()).toEqual({ ok: false, reason: 'no-node', message: expect.any(String) });
    expect(noNode.deps.install).not.toHaveBeenCalled();
    expect(codexInstallView(noNode.controller.getState())).toEqual({ kind: 'no-node', package: CODEX_PACKAGE });
  });

  it('does not push a duplicate installer when the CLI is already detected', async () => {
    const { controller, deps } = await running({ getStatus: vi.fn(async () => ({ ...baseStatus, installed: true })) });
    expect(codexInstallView(controller.getState())).toEqual({ kind: 'installed', justInstalled: false });
    expect(await controller.requestInstall()).toEqual({ ok: false, reason: 'installed', message: expect.any(String) });
    expect(deps.install).not.toHaveBeenCalled();
  });

  it('shows a bounded error on a real rejection and recovers on retry', async () => {
    const long = 'x'.repeat(2000);
    const install = vi
      .fn<() => Promise<CodexInstallResult>>()
      .mockRejectedValueOnce(new Error(long))
      .mockResolvedValueOnce({ outcome: 'installed', message: 'hecho' });
    const { controller } = await running({ install });
    const failed = await controller.requestInstall();
    expect(failed.ok).toBe(false);
    const message = controller.getState().error ?? '';
    expect(message.length).toBeGreaterThan(0);
    expect(message.length).toBeLessThanOrEqual(400);
    expect(codexInstallView(controller.getState()).kind).toBe('error');
    const retry = await controller.requestInstall();
    expect(retry).toEqual({ ok: true, outcome: 'installed' });
  });

  it('surfaces a passive status read failure without installing', async () => {
    const { controller, deps } = await running({ getStatus: vi.fn(async () => Promise.reject(new Error('backend caído'))) });
    expect(controller.getState().error).toMatch(/backend caído/);
    expect(deps.install).not.toHaveBeenCalled();
  });

  it('discards a passive read that lands after stop', async () => {
    const pending = deferred<CodexSetupStatus>();
    const { controller } = setup({ getStatus: vi.fn(() => pending.promise) });
    controller.start();
    controller.stop();
    pending.resolve({ ...baseStatus, installed: true });
    await flush();
    expect(controller.getState().status).toBeNull();
  });

  it('discards a passive read that lands after the component is hidden', async () => {
    const pending = deferred<CodexSetupStatus>();
    const { controller } = setup({ getStatus: vi.fn(() => pending.promise) });
    controller.start();
    controller.setVisible(true);
    controller.setVisible(false);
    pending.resolve({ ...baseStatus, installed: true });
    await flush();
    expect(controller.getState().status).toBeNull();
  });

  it('polls read-only while the backend is busy and stops once it clears', async () => {
    let busy = true;
    const getStatus = vi.fn(async () => ({ ...baseStatus, busy }));
    const timers: Array<() => void> = [];
    const setInterval = vi.fn((fn: () => void) => {
      timers.push(fn);
      return timers.length;
    });
    const clearInterval = vi.fn();
    const install = vi.fn(async () => ({ outcome: 'installed', message: 'ok' }) as CodexInstallResult);
    const { controller } = await running({ getStatus, install, setInterval, clearInterval, intervalMs: 10 });
    expect(controller.getState().status?.busy).toBe(true);
    expect(setInterval).toHaveBeenCalled();
    const before = getStatus.mock.calls.length;
    for (const fn of timers) fn();
    await flush();
    expect(getStatus.mock.calls.length).toBeGreaterThan(before);
    busy = false;
    for (const fn of timers) fn();
    await flush();
    expect(clearInterval).toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('keeps the pinned package visible instead of claiming latest', () => {
    expect(CODEX_PACKAGE).toBe('@openai/codex@0.162.1');
    expect(codexInstallView({ status: null, reading: true, installing: false, outcome: null, message: null, error: null, errorFrom: null })).toEqual({
      kind: 'loading',
    });
  });

  it('does not turn a successful install into a failure when the recheck or the follow-up read fails', async () => {
    const onInstalled = vi.fn(() => {
      throw new Error('el aviso falló');
    });
    const getStatus = vi.fn(async () => {
      throw new Error('lectura posterior caída');
    });
    const install = vi.fn(async () => ({ outcome: 'installed', message: 'hecho' }) as CodexInstallResult);
    const { controller } = await running({ install, onInstalled, getStatus });
    expect(await controller.requestInstall()).toEqual({ ok: true, outcome: 'installed' });
    await flush();
    expect(codexInstallView(controller.getState())).toEqual({ kind: 'installed', justInstalled: true });
  });

  it('recovers the ready state once the other window stops being busy and then installs', async () => {
    let busy = true;
    const getStatus = vi.fn(async () => ({ ...baseStatus, busy }));
    const install = vi.fn(async () => ({ outcome: 'installed', message: 'hecho' }) as CodexInstallResult);
    const { controller } = await running({ getStatus, install, intervalMs: 1_000_000 });
    expect(codexInstallView(controller.getState())).toEqual({ kind: 'busy' });
    busy = false;
    await controller.refresh();
    expect(codexInstallView(controller.getState())).toEqual({ kind: 'ready' });
    expect(await controller.requestInstall()).toEqual({ ok: true, outcome: 'installed' });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('re-reads the passive status when the component becomes visible again', async () => {
    const getStatus = vi.fn(async () => ({ ...baseStatus }));
    const { controller } = await running({ getStatus });
    const before = getStatus.mock.calls.length;
    controller.setVisible(false);
    controller.setVisible(true);
    await flush();
    expect(getStatus.mock.calls.length).toBeGreaterThan(before);
    expect(controller.getState().status?.installed).toBe(false);
  });

  it('maps a remembered failed outcome from the backend to an error view', () => {
    const state = stateFor({}, { outcome: 'failed', message: 'no se pudo validar la versión' });
    expect(codexInstallView(state)).toEqual({ kind: 'error', message: 'no se pudo validar la versión', origin: 'backend' });
  });

  it('never calls install from an inactive controller (stale button event)', async () => {
    const { controller, deps } = setup();
    expect(await controller.requestInstall()).toEqual({ ok: false, reason: 'inactive', message: expect.any(String) });
    expect(deps.install).not.toHaveBeenCalled();
    controller.stop();
    expect(await controller.requestInstall()).toEqual({ ok: false, reason: 'inactive', message: expect.any(String) });
    expect(deps.install).not.toHaveBeenCalled();
  });

  it('does not allow a duplicate install after stop/start while the backend is still pending', async () => {
    const pending = deferred<CodexInstallResult>();
    const install = vi.fn(() => pending.promise);
    const { controller } = await running({ install });
    const first = controller.requestInstall();
    controller.stop();
    controller.start();
    await flush();
    const dup = await controller.requestInstall();
    expect(dup).toEqual({ ok: false, reason: 'in-flight', message: expect.any(String) });
    expect(install).toHaveBeenCalledTimes(1);
    pending.resolve({ outcome: 'installed', message: 'ok' });
    await first;
    await flush();
    // Asentada la anterior, el siguiente intento ya instala.
    install.mockResolvedValueOnce({ outcome: 'installed', message: 'ok2' });
    expect(await controller.requestInstall()).toEqual({ ok: true, outcome: 'installed' });
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('keeps the CLI recheck when only the component unmounts', async () => {
    const onInstalled = vi.fn();
    const pending = deferred<CodexInstallResult>();
    const { controller } = await running({ install: vi.fn(() => pending.promise), onInstalled });
    const first = controller.requestInstall();
    controller.setVisible(false);
    pending.resolve({ outcome: 'installed', message: 'ok' });
    await first;
    await flush();
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(controller.getState().outcome).toBe('installed');
  });

  it('suppresses the recheck and the React update when the root stopped while installing', async () => {
    const onInstalled = vi.fn();
    const pending = deferred<CodexInstallResult>();
    const { controller } = await running({ install: vi.fn(() => pending.promise), onInstalled });
    const first = controller.requestInstall();
    controller.stop();
    pending.resolve({ outcome: 'installed', message: 'ok' });
    expect(await first).toEqual({ ok: true, outcome: 'installed' });
    await flush();
    expect(onInstalled).not.toHaveBeenCalled();
    expect(controller.getState().outcome).toBeNull();
    expect(controller.getState().installing).toBe(false);
  });

  it('labels a passive read failure as a metadata error and offers only recheck', async () => {
    const { controller, deps } = await running({ getStatus: vi.fn(async () => Promise.reject(new Error('backend caído'))) });
    const view = codexInstallView(controller.getState());
    expect(view).toEqual({ kind: 'error', message: expect.stringContaining('backend caído'), origin: 'read' });
    expect(codexInstallActions(view)).toEqual(['recheck']);
    expect(deps.install).not.toHaveBeenCalled();
  });

  it('labels an install rejection as an install error and offers retry plus recheck', async () => {
    const { controller } = await running({ install: vi.fn().mockRejectedValueOnce(new Error('rechazado')) });
    expect((await controller.requestInstall()).ok).toBe(false);
    const view = codexInstallView(controller.getState());
    expect(view).toEqual({ kind: 'error', message: 'rechazado', origin: 'install' });
    expect(codexInstallActions(view)).toEqual(['retry', 'recheck']);
  });

  it('exposes explicit allowed actions per view kind', () => {
    expect(codexInstallActions(codexInstallView(stateFor()))).toEqual(['install']);
    expect(codexInstallActions(codexInstallView(stateFor({}, { nodeAvailable: false })))).toEqual(['recheck', 'copy']);
    expect(codexInstallActions(codexInstallView(stateFor({}, { supported: false })))).toEqual(['recheck', 'copy']);
    expect(codexInstallActions(codexInstallView(stateFor({}, { installed: true })))).toEqual(['recheck']);
    expect(codexInstallActions(codexInstallView(stateFor({ installing: true })))).toEqual([]);
    expect(codexInstallActions(codexInstallView(stateFor({}, { busy: true })))).toEqual(['recheck']);
    expect(codexInstallActions(codexInstallView(stateFor({ outcome: 'cancelled' })))).toEqual(['retry']);
  });
});
