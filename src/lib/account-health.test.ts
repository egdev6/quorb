import { describe, expect, it, vi } from 'vitest';
import { openAccountLogin } from './account-login';
import { createPresencePoller, effectivePersisted, isConnectionDirty } from './account-health';

/** Lógica pura del paso de conexión: persistencia efectiva y presencia de sesión. */

describe('effectivePersisted', () => {
  it('no da por persistida una cuenta guardada con cambios pendientes', () => {
    expect(effectivePersisted(true, true)).toBe(false);
  });

  it('da por persistida solo cuando está guardada y sin cambios', () => {
    expect(effectivePersisted(true, false)).toBe(true);
  });

  it('no da por persistida una cuenta que no está guardada', () => {
    expect(effectivePersisted(false, false)).toBe(false);
    expect(effectivePersisted(false, true)).toBe(false);
  });

  it('una cuenta persistida pero sucia exige guardar antes de abrir el login', async () => {
    const order: string[] = [];
    const result = await openAccountLogin(effectivePersisted(true, true), {
      save: async () => {
        order.push('save');
        return true;
      },
      open: async () => {
        order.push('open');
      },
    });
    expect(result).toBe(true);
    expect(order).toEqual(['save', 'open']);
  });

  it('una cuenta persistida y limpia abre sin volver a guardar', async () => {
    const save = vi.fn(async () => true);
    const open = vi.fn(async () => {});
    expect(await openAccountLogin(effectivePersisted(true, false), { save, open })).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('isConnectionDirty', () => {
  const account = { id: 'claude:probe', provider: 'claude', configDir: null };
  const provider = { loginCommand: 'claude', credentialsPath: null };

  it('requires saving inherited provider edits even when the extra account is unchanged', () => {
    expect(isConnectionDirty(account, { ...account }, { ...provider, loginCommand: 'claude --profile work' }, provider)).toBe(true);
  });

  it('keeps an unchanged persisted extra account clean', () => {
    expect(isConnectionDirty(account, { ...account }, provider, { ...provider })).toBe(false);
  });

  it('still detects edits to the extra account itself', () => {
    expect(isConnectionDirty({ ...account, configDir: 'work-session' }, account, provider, provider)).toBe(true);
  });

  it('still detects main-provider configuration edits', () => {
    expect(isConnectionDirty(undefined, undefined, { ...provider, credentialsPath: 'work.json' }, provider)).toBe(true);
    expect(isConnectionDirty(undefined, undefined, provider, provider)).toBe(false);
  });

  // El entorno es parte de la conexión (revisión PR #92): cambiar de
  // Windows a WSL — o de una distro a otra — sin guardar deja la sección
  // sucia; el login usa lo GUARDADO, no lo que se ve en pantalla.
  it('detects a sessionEnv switch from host to wsl', () => {
    expect(
      isConnectionDirty(
        account,
        account,
        provider,
        provider,
        { sessionEnv: 'wsl', wslDistro: 'Ubuntu-22.04' },
        { sessionEnv: 'host', wslDistro: '' },
      ),
    ).toBe(true);
  });

  it('detects a distro change inside wsl', () => {
    expect(
      isConnectionDirty(
        account,
        account,
        provider,
        provider,
        { sessionEnv: 'wsl', wslDistro: 'Ubuntu-24.04' },
        { sessionEnv: 'wsl', wslDistro: 'Ubuntu-22.04' },
      ),
    ).toBe(true);
  });

  it('keeps an unchanged environment clean', () => {
    expect(
      isConnectionDirty(
        account,
        account,
        provider,
        provider,
        { sessionEnv: 'wsl', wslDistro: 'Ubuntu-22.04' },
        { sessionEnv: 'wsl', wslDistro: 'Ubuntu-22.04' },
      ),
    ).toBe(false);
  });
});

describe('createPresencePoller', () => {
  it.each(['result', 'rejection'] as const)('ignores a stale %s from an overlapping poll', async (stale) => {
    const requests: { resolve: (found: boolean) => void; reject: (error: Error) => void }[] = [];
    let tick!: () => void;
    const onResult = vi.fn();
    const poller = createPresencePoller({
      exists: () => new Promise<boolean>((resolve, reject) => requests.push({ resolve, reject })),
      onResult,
      setInterval: (fn) => { tick = fn; return 7; },
      clearInterval: () => {},
    });
    poller.start();
    tick();
    expect(requests).toHaveLength(2);
    requests[1].resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult.mock.calls).toEqual([[true]]);
    if (stale === 'result') requests[0].resolve(false);
    else requests[0].reject(new Error('stale poll failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult.mock.calls).toEqual([[true]]);
    poller.stop();
  });

  it.each(['result', 'rejection'] as const)('ignores a stale %s while the latest poll is pending', async (stale) => {
    const requests: { resolve: (found: boolean) => void; reject: (error: Error) => void }[] = [];
    let tick!: () => void;
    const onResult = vi.fn();
    const poller = createPresencePoller({
      exists: () => new Promise<boolean>((resolve, reject) => requests.push({ resolve, reject })),
      onResult,
      setInterval: (fn) => { tick = fn; return 7; },
      clearInterval: () => {},
    });
    poller.start();
    tick();
    expect(requests).toHaveLength(2);
    if (stale === 'result') requests[0].resolve(false);
    else requests[0].reject(new Error('stale poll failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult).not.toHaveBeenCalled();
    requests[1].reject(new Error('latest poll failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult.mock.calls).toEqual([[null]]);
    poller.stop();
  });

  it('discards old requests and timers after stop and restart', async () => {
    const requests: ((found: boolean) => void)[] = [];
    const ticks: (() => void)[] = [];
    const cleared: number[] = [];
    const exists = vi.fn(() => new Promise<boolean>((resolve) => requests.push(resolve)));
    const onResult = vi.fn();
    const poller = createPresencePoller({
      exists,
      onResult,
      setInterval: (fn) => { ticks.push(fn); return ticks.length; },
      clearInterval: (handle) => cleared.push(handle),
    });
    poller.start();
    poller.stop();
    poller.start();
    expect(cleared).toEqual([1]);
    ticks[0]();
    expect(exists).toHaveBeenCalledTimes(2);
    requests[0](false);
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult).not.toHaveBeenCalled();
    requests[1](true);
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult.mock.calls).toEqual([[true]]);
    poller.stop();
    expect(cleared).toEqual([1, 2]);
  });

  it('comprueba al arrancar y notifica el resultado vigente', async () => {
    const onResult = vi.fn();
    const poller = createPresencePoller({ exists: async () => true, onResult, setInterval: () => 0, clearInterval: () => {} });
    poller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(true);
    poller.stop();
  });

  it('notifica null cuando el sondeo falla (no conserva el último resultado)', async () => {
    const onResult = vi.fn();
    let tick: (() => void) | undefined;
    let attempt = 0;
    const poller = createPresencePoller({
      exists: async () => {
        attempt += 1;
        if (attempt === 1) return true;
        throw new Error('wsl caído');
      },
      onResult,
      setInterval: (fn) => {
        tick = fn;
        return 7;
      },
      clearInterval: () => {},
    });
    poller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult).toHaveBeenCalledWith(true);
    // Segunda comprobación que falla → `null` (desconocido), no `true` viejo.
    tick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult).toHaveBeenCalledWith(null);
    poller.stop();
  });

  it('descarta una respuesta en vuelo después de stop (desmontaje)', async () => {
    let resolve!: (value: boolean) => void;
    const onResult = vi.fn();
    const poller = createPresencePoller({
      exists: () => new Promise<boolean>((r) => (resolve = r)),
      onResult,
      setInterval: () => 0,
      clearInterval: () => {},
    });
    poller.start();
    poller.stop();
    resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('cancela el temporizador al parar y no vuelve a sondear', async () => {
    const cleared: number[] = [];
    let tick: (() => void) | undefined;
    const exists = vi.fn(async () => true);
    const poller = createPresencePoller({
      exists,
      onResult: () => {},
      intervalMs: 3000,
      setInterval: (fn) => {
        tick = fn;
        return 7;
      },
      clearInterval: (h) => cleared.push(h),
    });
    poller.start();
    expect(tick).toBeTypeOf('function');
    expect(cleared).toEqual([]);
    poller.stop();
    expect(cleared).toEqual([7]);
    tick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it('ignora un arranque doble', async () => {
    const exists = vi.fn(async () => true);
    const poller = createPresencePoller({ exists, onResult: () => {}, setInterval: () => 0, clearInterval: () => {} });
    poller.start();
    poller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(exists).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it('un fallo al comprobar no tumba el sondeo ni conserva el resultado viejo', async () => {
    const onResult = vi.fn();
    let tick: (() => void) | undefined;
    let fails = 0;
    const poller = createPresencePoller({
      exists: async () => {
        // El fallo solo ocurre una vez: el sondeo debe seguir tras él.
        fails += 1;
        if (fails === 1) throw new Error('boom');
        return true;
      },
      onResult,
      setInterval: (fn) => {
        tick = fn;
        return 7;
      },
      clearInterval: () => {},
    });
    poller.start();
    await Promise.resolve();
    await Promise.resolve();
    // El fallo se notifica como desconocido, no se traga en silencio.
    expect(onResult).toHaveBeenCalledWith(null);
    // Y el sondeo continúa: el siguiente tick vuelve a comprobar.
    tick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult).toHaveBeenCalledWith(true);
    poller.stop();
  });
});
