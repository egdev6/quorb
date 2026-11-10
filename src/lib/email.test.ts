import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { emailDefaults, emailReady, patchEmail, persistEmailTestAlerts, sendEmailTest } from './email';
import { createWriteQueue, enqueueCanonicalConfig, runMixedSave } from './settings-save';
import type { AlertsConfig, AppConfig } from './types';
import { api } from './api';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue('accepted') }));

const email = { enabled: false, consent: true, sender: 'sender@example.test', recipient: 'recipient@example.test' };

// Puente público simulado: el guardado devuelve la confirmación del backend.
// No acredita la UI montada, el llavero ni un envío real.
function persistenceFixture(globalEnabled: boolean, emailEnabled: boolean | undefined, failSave = false) {
  const alerts: AlertsConfig = {
    enabled: globalEnabled, native: true, threshold: 80, exceededEffect: 'none',
    onReset: true, resetEffect: 'none', exceededMedia: null, resetMedia: null,
    mediaSize: 'small', mediaSound: false,
    ...(emailEnabled === undefined ? {} : { email: { ...email, enabled: emailEnabled, consent: false, sender: '', recipient: '' } }),
  };
  let stored = { locale: 'es', opacity: 0.5, alerts } as AppConfig;
  let baseline = stored;
  const mockInvoke = vi.mocked(invoke);
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === 'get_config') return structuredClone(stored);
    if (command === 'save_config') {
      if (failSave) throw new Error('synthetic save failure');
      stored = structuredClone((args as { config: AppConfig }).config);
      return structuredClone(stored);
    }
    if (command === 'send_email_alert') return 'accepted';
    throw new Error(`Unexpected command: ${command}`);
  });
  const queue = createWriteQueue();
  const enqueueSave = (build: () => AppConfig | Promise<AppConfig>) => queue.run(async () => {
    const saved = await api.saveConfig(await build());
    baseline = saved;
    return saved;
  });
  return { mockInvoke, queue, enqueueSave, stored: () => stored, baseline: () => baseline };
}

const draftAlerts = (saved: AlertsConfig, globalEnabled: boolean, emailEnabled: boolean): AlertsConfig => ({
  ...saved, enabled: globalEnabled, email: { ...email, enabled: emailEnabled },
});

const sendTest = (alerts: AlertsConfig, enqueueSave: ReturnType<typeof persistenceFixture>['enqueueSave']) =>
  sendEmailTest(alerts.email!, () => persistEmailTestAlerts(alerts, enqueueSave), () => api.sendEmailAlert(null));

describe('email test persistence (#256, S16)', () => {
  afterEach(() => vi.mocked(invoke).mockReset().mockResolvedValue('accepted'));

  it.each([
    [false, false, true, true],
    [false, true, true, false],
    [true, false, false, true],
    [true, true, false, false],
    [false, undefined, true, true],
    [true, undefined, false, true],
  ] as const)('preserves saved switches (%s, %s) instead of draft (%s, %s)', async (savedGlobal, savedEmail, draftGlobal, draftEmail) => {
    const f = persistenceFixture(savedGlobal, savedEmail);
    const original = structuredClone(f.stored());
    const alerts = draftAlerts(original.alerts, draftGlobal, draftEmail);
    const beforeDraft = structuredClone(alerts);
    const expected = {
      ...original,
      alerts: { ...alerts, enabled: savedGlobal, email: { ...email, enabled: savedEmail ?? false } },
    };

    expect(await sendTest(alerts, f.enqueueSave)).toBe('accepted');
    expect(f.mockInvoke.mock.calls).toEqual([
      ['get_config'], ['save_config', { config: expected }], ['send_email_alert', { event: null }],
    ]);
    expect(f.stored()).toEqual(expected);
    expect(f.baseline()).toEqual(expected);
    expect(alerts).toEqual(beforeDraft);
  });

  it('reads the saved switches inside the queue after an earlier write confirms', async () => {
    const f = persistenceFixture(false, false);
    const alerts = draftAlerts(f.stored().alerts, false, false);
    let release!: () => void;
    const earlier = f.enqueueSave(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { ...f.stored(), opacity: 0.8, alerts: { ...f.stored().alerts, enabled: true, email: { ...email, enabled: true } } };
    });
    await Promise.resolve();
    const pending = sendTest(alerts, f.enqueueSave);
    expect(f.mockInvoke).not.toHaveBeenCalled();
    release();
    await earlier;
    const latest = structuredClone(f.stored());
    expect(await pending).toBe('accepted');
    const expected = { ...latest, alerts: { ...alerts, enabled: true, email: { ...email, enabled: true } } };
    expect(f.mockInvoke.mock.calls).toEqual([
      ['save_config', { config: latest }], ['get_config'],
      ['save_config', { config: expected }], ['send_email_alert', { event: null }],
    ]);
    expect(f.stored()).toEqual(expected);
    expect(f.baseline()).toEqual(expected);
  });

  it('does not send or change stored data or baseline when persistence fails', async () => {
    const f = persistenceFixture(false, false, true);
    const original = structuredClone(f.stored());
    const alerts = draftAlerts(original.alerts, true, true);
    expect(await sendTest(alerts, f.enqueueSave)).toBe('serviceError');
    expect(f.mockInvoke.mock.calls).toEqual([
      ['get_config'],
      ['save_config', { config: { ...original, alerts: { ...alerts, enabled: false, email: { ...email, enabled: false } } } }],
    ]);
    expect(f.stored()).toEqual(original);
    expect(f.baseline()).toEqual(original);
  });

  it.each([[true, true], [true, false], [false, true], [false, false]] as const)(
    'normal Save still persists draft switches (%s, %s) through the canonical coordinator',
    async (globalEnabled, emailEnabled) => {
      const f = persistenceFixture(!globalEnabled, !emailEnabled);
      const snapshot = { ...f.stored(), alerts: draftAlerts(f.stored().alerts, globalEnabled, emailEnabled) };
      const applyAutostart = vi.fn();
      const result = await runMixedSave(
        { configDirty: true, configSnapshot: snapshot, autostartDirty: false, autostartDesired: false },
        { saveConfig: (s) => enqueueCanonicalConfig(f.enqueueSave, s, () => ({})), applyAutostart },
      );
      expect(result).toEqual({ config: { status: 'saved', saved: snapshot }, autostart: { status: 'skipped' } });
      expect(f.mockInvoke.mock.calls).toEqual([['save_config', { config: snapshot }]]);
      expect(f.stored()).toEqual(snapshot);
      expect(f.baseline()).toEqual(snapshot);
      expect(applyAutostart).not.toHaveBeenCalled();
    },
  );
});

describe('email Settings actions', () => {
  it('defaults off, save does not enable, revocation disables, disable preserves config', () => {
    expect(emailDefaults).toEqual({ enabled: false, consent: false, sender: '', recipient: '' });
    expect(patchEmail(undefined, { sender: email.sender }).enabled).toBe(false);
    expect(patchEmail({ ...email, enabled: true }, { consent: false })).toEqual({ ...email, enabled: false, consent: false });
    expect(patchEmail({ ...email, enabled: true }, { enabled: false })).toEqual(email);
    expect(patchEmail(undefined, { enabled: true }).enabled).toBe(false);
  });

  it('requires explicit consent and valid addresses before persisting or sending', async () => {
    const persist = vi.fn(); const send = vi.fn();
    expect(emailReady(undefined)).toBe(false);
    expect(await sendEmailTest({ ...email, consent: false }, persist, send)).toBe('consentRequired');
    expect(await sendEmailTest({ ...email, sender: 'bad\r\naddress' }, persist, send)).toBe('configurationMissing');
    expect(persist).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('persists before one explicit test and never activates automatic sending', async () => {
    const order: string[] = [];
    const persist = vi.fn(async () => { order.push('save'); });
    const send = vi.fn(async () => { order.push('send'); return 'accepted' as const; });
    const before = { ...email };
    expect(await sendEmailTest(email, persist, send)).toBe('accepted');
    expect(order).toEqual(['save', 'send']); expect(send).toHaveBeenCalledTimes(1);
    expect(email).toEqual(before); expect(email.enabled).toBe(false);
  });

  it('failed save does not send and diagnostics never echo errors', async () => {
    const send = vi.fn();
    const persist = vi.fn().mockRejectedValue('private-address secret-value');
    expect(await sendEmailTest(email, persist, send)).toBe('serviceError');
    expect(send).not.toHaveBeenCalled();
    expect(await sendEmailTest(email, async () => {}, vi.fn().mockRejectedValue('private'))).toBe('acceptanceUnknown');
  });

  it('the public bridge sends no key or configuration and separates status from test', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await api.sendEmailAlert(null);
    expect(invoke).toHaveBeenLastCalledWith('send_email_alert', { event: null });
    await api.emailStatus();
    expect(invoke).toHaveBeenLastCalledWith('email_status');
  });

  // Regresión T6 (#245): pin del coordinador real de guardado de Ajustes,
  // `runMixedSave` + `api.saveConfig` con el puente Tauri mockeado, no un
  // doble de la persistencia. Guardar con email deshabilitado conserva
  // consentimiento y direcciones y emite solo `save_config`: nunca `set_secret`
  // de nuevo ni ningún borrado de clave. Esto acredita la orquestación, no la
  // persistencia del llavero del SO (manual por plataforma, S24) ni la UI
  // montada ni lo visual.
  it('saving email disabled through the real save coordinator keeps consent and addresses and never touches secrets', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockClear();
    mockInvoke.mockImplementationOnce(
      async (_command: string, args?: unknown) => (args as { config: AppConfig }).config,
    );
    const snapshot = {
      alerts: { email: patchEmail({ ...email, enabled: true }, { enabled: false }) },
    } as unknown as AppConfig;
    const applyAutostart = vi.fn(async () => {
      throw new Error('autostart no debe aplicarse');
    });
    const result = await runMixedSave(
      { configDirty: true, configSnapshot: snapshot, autostartDirty: false, autostartDesired: false },
      { saveConfig: api.saveConfig, applyAutostart },
    );
    expect(result.config).toEqual({ status: 'saved', saved: snapshot });
    expect(result.autostart.status).toEqual('skipped');
    expect(snapshot.alerts.email).toEqual({
      enabled: false,
      consent: true,
      sender: 'sender@example.test',
      recipient: 'recipient@example.test',
    });
    expect(mockInvoke.mock.calls).toEqual([['save_config', { config: snapshot }]]);
  });
});
