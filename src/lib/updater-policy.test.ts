import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), check: vi.fn(), install: vi.fn(), relaunch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.check.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe('backend updater policy', () => {
  it.each(['manual', 'invalid', undefined])('blocks check/install/relaunch for %s', async (mode) => {
    mocks.invoke.mockResolvedValue(mode);
    const { checkForUpdate, installUpdate } = await import('./updater');
    await expect(checkForUpdate()).rejects.toThrow();
    await expect(installUpdate(vi.fn())).rejects.toThrow();
    expect(mocks.invoke).toHaveBeenCalledWith('updater_mode');
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it.each(['async', 'sync'])('fails closed on a %s policy error without plugin fallback', async (kind) => {
    if (kind === 'async') mocks.invoke.mockRejectedValue(new Error('IPC unavailable'));
    else mocks.invoke.mockImplementation(() => { throw new Error('IPC unavailable'); });
    const { getUpdaterMode } = await import('./updater-policy');
    await expect(getUpdaterMode()).resolves.toBe('error');
    const { checkForUpdate, installUpdate } = await import('./updater');
    await expect(checkForUpdate()).rejects.toThrow();
    await expect(installUpdate(vi.fn())).rejects.toThrow();
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it('waits for policy resolution and shares one backend request', async () => {
    let resolve!: (mode: string) => void;
    mocks.invoke.mockReturnValue(new Promise<string>((done) => { resolve = done; }));
    const { checkForUpdate, installUpdate } = await import('./updater');
    const check = checkForUpdate();
    const install = installUpdate(vi.fn());
    const results = Promise.allSettled([check, install]);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await Promise.resolve();
    resolve('manual');
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('preserves native checking, cached installation, progress and restart', async () => {
    mocks.invoke.mockResolvedValue('native');
    mocks.check.mockResolvedValue({ version: '0.7.0', downloadAndInstall: mocks.install });
    mocks.install.mockImplementation(async (progress) => progress({ event: 'Finished' }));
    const { checkForUpdate, installUpdate } = await import('./updater');
    expect(await checkForUpdate()).toEqual({ version: '0.7.0', notes: null, date: null });
    const progress = vi.fn();
    await installUpdate(progress);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(100);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown', 'manual', 'error', 'native'] as const)('schedules polling only for native: %s', async (mode) => {
    const { startUpdatePolling, UPDATE_FIRST_DELAY_MS, UPDATE_EVERY_MS } = await import('./updater');
    vi.useFakeTimers();
    const run = vi.fn();
    const stop = startUpdatePolling(mode, run);
    expect(vi.getTimerCount()).toBe(mode === 'native' ? 2 : 0);
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(mode === 'native' ? 1 : 0);
    await vi.advanceTimersByTimeAsync(UPDATE_EVERY_MS);
    expect(run).toHaveBeenCalledTimes(mode === 'native' ? 2 : 0);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('effective updater capabilities', () => {
  it('autoloads capabilities with no updater grant on macOS and preserves Windows/Linux windows', async () => {
    const fs = await vi.importActual<{ readFileSync(path: URL, encoding: string): string; readdirSync(path: URL): string[] }>('node:fs');
    const json = (path: string) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
    for (const config of ['tauri.conf.json', 'tauri.macos.conf.json', 'tauri.release.conf.json']) {
      expect(json(`../../src-tauri/${config}`).app?.security?.capabilities).toBeUndefined();
    }
    const dir = new URL('../../src-tauri/capabilities/', import.meta.url);
    const caps = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => json(`../../src-tauri/capabilities/${file}`));
    const grants = (platform: string) => caps.filter((cap) => !cap.platforms || cap.platforms.includes(platform))
      .filter((cap) => cap.permissions.some((permission: string) => permission.startsWith('updater:')));
    expect(grants('macOS')).toEqual([]);
    for (const platform of ['windows', 'linux']) {
      expect(grants(platform)).toMatchObject([{ windows: ['widget', 'settings', 'overlay'], permissions: ['updater:default'] }]);
    }
    expect(json('../../src-tauri/capabilities/default.json').permissions).toContain('process:allow-restart');
  });
});
