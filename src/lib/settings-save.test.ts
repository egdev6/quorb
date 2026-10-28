import { describe, expect, it, vi } from 'vitest';
import type { Account, AppConfig, SecretStatus } from './types';
import type { AutostartApplyOutcome } from './autostart-controller';
import { accountReady } from './accounts';
import { configPersistedAfterSave, createWriteQueue, enqueueCanonicalConfig, mixedSaveMessage, reloadSecretsAfterSave, runMixedSave, type MixedSaveDeps, type MixedSaveInput, type MixedSaveResult } from './settings-save';

const config = (over: Record<string, unknown> = {}) =>
  ({ refreshMinutes: 5, orbSize: 48, accentColor: '#ff0036', ...over }) as unknown as AppConfig;

const confirmed = (desired: boolean): AutostartApplyOutcome => ({ ok: true, confirmed: desired, skipped: false });
const failure = (message: string): Extract<AutostartApplyOutcome, { ok: false }> => ({ ok: false, stage: 'apply', message });

function setup(over: Partial<MixedSaveDeps> = {}) {
  const deps: MixedSaveDeps = {
    saveConfig: vi.fn(async (snapshot: AppConfig) => snapshot),
    applyAutostart: vi.fn(async (desired: boolean) => confirmed(desired)),
    ...over,
  };
  return deps;
}

const input = (over: Partial<MixedSaveInput> = {}): MixedSaveInput => ({
  configDirty: false,
  configSnapshot: config(),
  autostartDirty: false,
  autostartDesired: false,
  ...over,
});

const result = (config: MixedSaveResult['config'], autostart: MixedSaveResult['autostart']): MixedSaveResult => ({ config, autostart });

describe('createWriteQueue (B5)', () => {
  it('serializa las escrituras: un patch vivo no se cruza con un guardado manual en vuelo', async () => {
    const queue = createWriteQueue();
    const order: string[] = [];
    let releaseManual!: () => void;
    const manual = queue.run(async () => {
      order.push('manual:start');
      await new Promise<void>((resolve) => {
        releaseManual = resolve;
      });
      order.push('manual:end');
      return 'manual';
    });
    const live = queue.run(async () => {
      order.push('live');
      return 'live';
    });
    await Promise.resolve();
    // El patch vivo no empieza hasta que el guardado manual suelta la cola.
    expect(order).toEqual(['manual:start']);
    releaseManual();
    await Promise.all([manual, live]);
    expect(order).toEqual(['manual:start', 'manual:end', 'live']);
  });

  it('sobrevive a un rechazo y sigue encolando lo siguiente', async () => {
    const queue = createWriteQueue();
    const failed = queue.run(async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');
    await expect(queue.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('enqueueCanonicalConfig', () => {
  it('reads live values at execution after the older queued write settles', async () => {
    const queue = createWriteQueue();
    let canonical: Partial<AppConfig> = { opacity: 0.2 };
    let release!: () => void;
    const live = queue.run(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      canonical = { opacity: 0.8 };
    });
    await Promise.resolve();
    const snapshot = config({ opacity: 0.2, refreshMinutes: 30 });
    const persisted = vi.fn(async (cfg: AppConfig) => cfg);
    const manual = enqueueCanonicalConfig(
      (build) => queue.run(() => persisted(build())), snapshot, () => canonical,
    );
    expect(persisted).not.toHaveBeenCalled();
    release();
    await live;
    expect(await manual).toEqual(config({ opacity: 0.8, refreshMinutes: 30 }));
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(snapshot.opacity).toBe(0.2);
  });
});

 describe('runMixedSave', () => {
  it('does nothing when no part is dirty', async () => {
    const deps = setup();
    const result = await runMixedSave(input(), deps);
    expect(result).toEqual({ config: { status: 'skipped' }, autostart: { status: 'skipped' } });
    expect(deps.saveConfig).not.toHaveBeenCalled();
    expect(deps.applyAutostart).not.toHaveBeenCalled();
  });

  it('saves only the autostart part when the config is clean', async () => {
    const deps = setup();
    const result = await runMixedSave(input({ autostartDirty: true, autostartDesired: true }), deps);
    expect(result).toEqual({ config: { status: 'skipped' }, autostart: { status: 'confirmed' } });
    expect(deps.saveConfig).not.toHaveBeenCalled();
    expect(deps.applyAutostart).toHaveBeenCalledWith(true);
  });

  it('saves only the config part when autostart is clean', async () => {
    const snapshot = config({ refreshMinutes: 30 });
    const deps = setup({ saveConfig: vi.fn(async () => config({ refreshMinutes: 30, accentColor: '#abcdef' })) });
    const result = await runMixedSave(input({ configDirty: true, configSnapshot: snapshot }), deps);
    expect(result).toEqual({ config: { status: 'saved', saved: config({ refreshMinutes: 30, accentColor: '#abcdef' }) }, autostart: { status: 'skipped' } });
    expect(deps.applyAutostart).not.toHaveBeenCalled();
  });

  it('keeps the config success and the autostart failure in one pass', async () => {
    const saved = config({ refreshMinutes: 30 });
    const deps = setup({
      saveConfig: vi.fn(async () => saved),
      applyAutostart: vi.fn(async () => failure('denied')),
    });
    const result = await runMixedSave(input({ configDirty: true, autostartDirty: true, autostartDesired: true }), deps);
    expect(result.config).toEqual({ status: 'saved', saved });
    expect(result.autostart).toMatchObject({ status: 'failed', outcome: { message: 'denied' } });
  });

  it('keeps the autostart reachability when the config fails', async () => {
    const deps = setup({
      saveConfig: vi.fn(async () => Promise.reject(new Error('write failed'))),
      applyAutostart: vi.fn(async () => confirmed(false)),
    });
    const result = await runMixedSave(input({ configDirty: true, autostartDirty: true, autostartDesired: false }), deps);
    expect(result.config).toEqual({ status: 'failed', message: 'write failed' });
    expect(result.autostart).toEqual({ status: 'confirmed' });
  });

  it('reports both failures without a fake success', async () => {
    const deps = setup({
      saveConfig: vi.fn(async () => Promise.reject(new Error('cfg boom'))),
      applyAutostart: vi.fn(async () => failure('os boom')),
    });
    const result = await runMixedSave(input({ configDirty: true, autostartDirty: true, autostartDesired: true }), deps);
    expect(result.config).toEqual({ status: 'failed', message: 'cfg boom' });
    expect(result.autostart).toMatchObject({ status: 'failed', outcome: { message: 'os boom' } });
  });

  it('reports full success for both parts', async () => {
    const saved = config({ opacity: 0.5 });
    const deps = setup({ saveConfig: vi.fn(async () => saved), applyAutostart: vi.fn(async () => confirmed(true)) });
    const result = await runMixedSave(input({ configDirty: true, autostartDirty: true, autostartDesired: true }), deps);
    expect(result).toEqual({ config: { status: 'saved', saved }, autostart: { status: 'confirmed' } });
  });
});

describe('reloadSecretsAfterSave', () => {
  const account: Account = {
    id: 'openrouter:abc123',
    provider: 'openrouter',
    label: 'Cuenta 2',
    enabled: true,
    configDir: null,
    username: '',
    plan: '',
    customAllowance: null,
    monthlyBudgetUsd: null,
  };

  it('relee los secretos tras persistir la cuenta para que deje de faltar conectar', async () => {
    // El backend (`secret_status`) solo enumera cuentas ya persistidas: la key
    // guardada antes de crear la cuenta no aparece hasta que se guarda la config.
    let persisted = false;
    const reload = vi.fn(async (): Promise<SecretStatus> => (persisted ? { 'openrouter_api_key@openrouter:abc123': true } : {}));
    expect(accountReady(account, await reload())).toBe(false);
    persisted = true;
    const status = await reloadSecretsAfterSave({ status: 'saved', saved: config() }, reload);
    expect(status).not.toBeNull();
    expect(accountReady(account, status ?? {})).toBe(true);
  });

  it('no relee secretos si la config no se guardó', async () => {
    const reload = vi.fn(async (): Promise<SecretStatus> => ({}));
    expect(await reloadSecretsAfterSave({ status: 'failed', message: 'write failed' }, reload)).toBeNull();
    expect(await reloadSecretsAfterSave({ status: 'skipped' }, reload)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('configPersistedAfterSave', () => {
  it('da la config por persistida aunque el autostart falle', () => {
    // Con la config guardada, un fallo del sistema operativo no debe bloquear
    // el login: la cuenta ya está donde el CLI la busca.
    expect(configPersistedAfterSave(result({ status: 'saved', saved: config() }, { status: 'failed', outcome: failure('denied') }))).toBe(true);
  });

  it('da la config por persistida si no había cambios que guardar', () => {
    // `skipped` deja la config tal cual estaba: sigue siendo la persistida.
    expect(configPersistedAfterSave(result({ status: 'skipped' }, { status: 'failed', outcome: failure('denied') }))).toBe(true);
    expect(configPersistedAfterSave(result({ status: 'skipped' }, { status: 'confirmed' }))).toBe(true);
  });

  it('no da la config por persistida si su parte falló', () => {
    expect(configPersistedAfterSave(result({ status: 'failed', message: 'write failed' }, { status: 'confirmed' }))).toBe(false);
    expect(configPersistedAfterSave(result({ status: 'failed', message: 'write failed' }, { status: 'skipped' }))).toBe(false);
  });
});

describe('mixedSaveMessage', () => {
  const cfgSaved: MixedSaveResult['config'] = { status: 'saved', saved: config() };
  const cfgFailed: MixedSaveResult['config'] = { status: 'failed', message: 'write failed' };
  const osConfirmed: MixedSaveResult['autostart'] = { status: 'confirmed' };
  const osFailed: MixedSaveResult['autostart'] = { status: 'failed', outcome: failure('denied') };
  const skipped = { status: 'skipped' as const };

  it('localizes every outcome in English without leaking Spanish (T2c-S2 PR-B)', () => {
    expect(mixedSaveMessage(result(cfgSaved, skipped), 'en')).toBe('Saved ✓');
    expect(mixedSaveMessage(result(cfgSaved, osFailed), 'en')).toBe('Settings saved · Start at login not saved: denied');
    expect(mixedSaveMessage(result(cfgFailed, osConfirmed), 'en')).toBe('Start at login saved · Settings not saved: write failed');
    expect(mixedSaveMessage(result(cfgFailed, osFailed), 'en')).toBe('Settings not saved: write failed · Start at login not saved: denied');
    expect(mixedSaveMessage(result(skipped, skipped), 'en')).toBeNull();
  });

  it('keeps the Spanish texts verbatim when the locale is es', () => {
    expect(mixedSaveMessage(result(cfgSaved, skipped), 'es')).toBe('Guardado ✓');
    expect(mixedSaveMessage(result(cfgSaved, osFailed), 'es')).toBe('Configuración guardada · Inicio al iniciar sesión no guardado: denied');
    expect(mixedSaveMessage(result(cfgFailed, osConfirmed), 'es')).toBe('Inicio al iniciar sesión guardado · Configuración no guardada: write failed');
  });

  it('names the saved config and the failed Windows part in a mixed result', () => {
    const message = mixedSaveMessage(result(cfgSaved, osFailed));
    expect(message).toMatch(/Configuración guardada/);
    expect(message).toMatch(/Inicio al iniciar sesión no guardado: denied/);
    expect(message).not.toContain('Guardado ✓');
  });

  it('names the saved Windows part and the failed config in a mixed result', () => {
    const message = mixedSaveMessage(result(cfgFailed, osConfirmed));
    expect(message).toMatch(/Inicio al iniciar sesión guardado/);
    expect(message).toMatch(/Configuración no guardada: write failed/);
    expect(message).not.toContain('Guardado ✓');
  });

  it('names both errors when both parts fail', () => {
    const message = mixedSaveMessage(result(cfgFailed, osFailed));
    expect(message).toMatch(/Configuración no guardada: write failed/);
    expect(message).toMatch(/Inicio al iniciar sesión no guardado: denied/);
  });

  it('never claims a skipped part was saved', () => {
    const cfgOnly = mixedSaveMessage(result(cfgFailed, skipped));
    expect(cfgOnly).toMatch(/Configuración no guardada: write failed/);
    expect(cfgOnly).not.toMatch(/Inicio al iniciar sesión/);
    const osOnly = mixedSaveMessage(result(skipped, osFailed));
    expect(osOnly).toMatch(/Inicio al iniciar sesión no guardado: denied/);
    expect(osOnly).not.toMatch(/Configuración guardada/);
  });

  it('has no message when there was nothing to save', () => {
    expect(mixedSaveMessage(result(skipped, skipped))).toBeNull();
  });

  it('reports one valid confirmation when the saved parts succeeded', () => {
    expect(mixedSaveMessage(result(cfgSaved, osConfirmed))).toBe('Guardado ✓');
    expect(mixedSaveMessage(result(cfgSaved, skipped))).toBe('Guardado ✓');
    expect(mixedSaveMessage(result(skipped, osConfirmed))).toBe('Guardado ✓');
  });
});
