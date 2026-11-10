import { describe, expect, it, vi } from 'vitest';
import { detectAlerts, effectFor, nativeAlertsEnabled, notificationText, windowKey } from './alerts';
import { dispatchEmailAlerts } from './email';
import type { AlertsConfig, UsageReport } from './types';

const now = Date.parse('2026-10-06T12:00:00Z');
const window = '2026-10-06T15:00:00Z';
const nextWindow = '2026-10-06T20:00:00Z';
const report = (percent: number, resetsAt = window, id = 'claude'): UsageReport => ({
  id, name: 'Private account name', kind: 'subscription', status: 'ok', plan: null,
  meters: [{ id: 'session', label: 'Private meter label', percent, used: null, limit: null, unit: null, resetsAt, windowSeconds: 18000 }],
  spend: null, message: null, action: null, fetchedAt: '',
});
const config: AlertsConfig = {
  enabled: true, native: true, threshold: 90, onReset: true,
  exceededEffect: 'glow', resetEffect: 'confetti', exceededMedia: null, resetMedia: null, mediaSize: 'small', mediaSound: false,
  email: { enabled: true, consent: true, sender: 'sender@example.test', recipient: 'recipient@example.test' },
};

describe('automatic email uses the existing detectAlerts stream', () => {
  it('projects exact provider/meter/window/type identity without exporting account identities or labels', async () => {
    const detected = detectAlerts([], [report(95, window, 'claude:private-account')], {}, config, now);
    expect(detected.events[0]).toMatchObject({ providerId: 'claude:private-account', meterId: 'session', realMeterId: 'session', window: windowKey(window), kind: 'exceeded' });
    const send = vi.fn().mockResolvedValue('accepted');
    await dispatchEmailAlerts(detected.events, config, send);
    expect(send).toHaveBeenCalledExactlyOnceWith({ provider: 'claude', meter: 'session', window: windowKey(window), percent: 95, kind: 'exceeded' });
    const serialized = JSON.stringify(send.mock.calls);
    for (const value of ['private-account', 'Private account name', 'Private meter label', 'sender@example.test']) expect(serialized).not.toContain(value);
    expect(detected.memory).toEqual({ [`claude:private-account|session|${windowKey(window)}`]: 'exceeded' });
  });

  it.each(['alice_private', 'session', 'Alice Private', 'alice-private', 'Sesión · 5 h'])(
    'keeps the legacy label %s local even when it looks like a valid meter ID', async (label) => {
      const legacy = (percent: number, resetsAt = window): UsageReport => {
        const r = report(percent, resetsAt);
        r.meters[0] = { ...r.meters[0], id: '', label };
        return r;
      };
      const first = detectAlerts([], [legacy(95)], {}, config, now);
      const memory = { [`claude|${label}|${windowKey(window)}`]: 'exceeded' };
      expect(first.events).toHaveLength(1);
      expect(first.events[0]).toMatchObject({ kind: 'exceeded', providerId: 'claude', providerName: 'Private account name', meterId: label, realMeterId: '', window: windowKey(window), label, percent: 95 });
      expect(first.memory).toEqual(memory);
      expect(notificationText(first.events)).toEqual({ title: 'Límite superado', body: `Private account name · ${label}: 95 %` });
      const snapshot = JSON.stringify(first);
      const send = vi.fn().mockResolvedValue('accepted');
      await expect(dispatchEmailAlerts(first.events, config, send)).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledExactlyOnceWith({ provider: 'claude', meter: 'usage', window: windowKey(window), percent: 95, kind: 'exceeded' });
      expect(JSON.stringify(first)).toBe(snapshot);
      const repeat = detectAlerts([legacy(95)], [legacy(99)], first.memory, config, now);
      expect(repeat).toEqual({ events: [], memory });
      await dispatchEmailAlerts(repeat.events, config, send);
      expect(send).toHaveBeenCalledTimes(1);

      const reset = detectAlerts([legacy(99)], [legacy(2, nextWindow)], repeat.memory, config, now);
      expect(reset.events).toHaveLength(1);
      expect(reset.events[0]).toMatchObject({ kind: 'reset', meterId: label, label, percent: 2 });
      expect(reset.memory).toEqual(memory);
      expect(notificationText(reset.events)).toEqual({ title: 'Límite reiniciado', body: `Private account name · ${label}: disponible de nuevo (2 %)` });
      await dispatchEmailAlerts(reset.events, config, send);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith({ provider: 'claude', meter: 'usage', window: windowKey(nextWindow), percent: 2, kind: 'reset' });
      expect(reset.memory).toEqual(memory);
    },
  );

  it('one failed attempt stays consumed, repeated polling does not retry, a new window can send', async () => {
    const send = vi.fn().mockRejectedValue('private remote error');
    const first = detectAlerts([], [report(95)], {}, config, now);
    const snapshot = JSON.stringify(first.memory);
    await expect(dispatchEmailAlerts(first.events, config, send)).resolves.toBeUndefined();
    const repeat = detectAlerts([report(95)], [report(99)], first.memory, config, now);
    await dispatchEmailAlerts(repeat.events, config, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first.memory)).toBe(snapshot);
    const next = detectAlerts([report(99)], [report(96, nextWindow)], repeat.memory, config, now);
    await dispatchEmailAlerts(next.events, config, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(Object.keys(next.memory)).toEqual([`claude|session|${windowKey(window)}`, `claude|session|${windowKey(nextWindow)}`]);
  });

  it('reset is the same transition as local notifications and does not add memory', async () => {
    const first = detectAlerts([], [report(95)], {}, config, now);
    const reset = detectAlerts([report(95)], [report(2, nextWindow)], first.memory, config, now);
    const send = vi.fn().mockResolvedValue('accepted');
    await dispatchEmailAlerts(reset.events, config, send);
    const repeatedPoll = detectAlerts([report(2, nextWindow)], [report(2, nextWindow)], reset.memory, config, now);
    await dispatchEmailAlerts(repeatedPoll.events, config, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ provider: 'claude', meter: 'session', window: windowKey(nextWindow), percent: 2, kind: 'reset' });
    expect(reset.memory).toEqual(first.memory);
    expect(notificationText(reset.events)).toEqual({ title: 'Límite reiniciado', body: 'Private account name · Private meter label: disponible de nuevo (2 %)' });
    expect(effectFor(reset.events, config)).toEqual({ effect: 'confetti', moment: 'reset' });
  });

  it('global/email govern remote sends independently of native and require valid consent/config', async () => {
    const events = detectAlerts([], [report(95)], {}, config, now).events;
    for (const enabled of [false, true]) for (const email of [false, true]) for (const native of [false, true]) {
      const cfg = { ...config, enabled, native, email: { ...config.email!, enabled: email } };
      const send = vi.fn().mockResolvedValue('accepted');
      await dispatchEmailAlerts(events, cfg, send);
      expect(send).toHaveBeenCalledTimes(enabled && email ? 1 : 0);
      expect(nativeAlertsEnabled(cfg)).toBe(enabled && native);
    }
    for (const email of [undefined, { ...config.email!, consent: false }, { ...config.email!, recipient: '' }]) {
      const send = vi.fn(); await dispatchEmailAlerts(events, { ...config, email }, send); expect(send).not.toHaveBeenCalled();
    }
  });

  it('enabling later never replays events already consumed by local memory', async () => {
    const send = vi.fn().mockResolvedValue('accepted');
    const first = detectAlerts([], [report(95)], {}, config, now);
    await dispatchEmailAlerts(first.events, { ...config, email: { ...config.email!, enabled: false } }, send);
    const next = detectAlerts([report(95)], [report(96)], first.memory, config, now);
    await dispatchEmailAlerts(next.events, config, send);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps legacy/no-window behavior and does not leak arbitrary legacy meter labels', async () => {
    const legacy = report(95); legacy.meters[0].id = ''; legacy.meters[0].resetsAt = null;
    const first = detectAlerts([], [legacy], {}, config, now);
    const send = vi.fn().mockResolvedValue('accepted');
    await dispatchEmailAlerts(first.events, config, send);
    expect(send).toHaveBeenCalledWith({ provider: 'claude', meter: 'usage', window: 'none', percent: 95, kind: 'exceeded' });
    expect(detectAlerts([legacy], [legacy], first.memory, config, now).events).toEqual([]);
    const remembered = { [`claude|Private meter label|${windowKey(window)}`]: 'exceeded' } as const;
    expect(detectAlerts([], [report(95)], remembered, config, now).events).toEqual([]);
  });

  it('HTTP rejection or a synchronous send failure never changes local text/effects or blocks siblings', async () => {
    const events = detectAlerts([], [report(95), report(98, window, 'codex')], {}, config, now).events;
    const local = notificationText(events); const fx = effectFor(events, config);
    const send = vi.fn(() => { throw Error('private'); });
    await expect(dispatchEmailAlerts(events, config, send)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(notificationText(events)).toEqual(local); expect(effectFor(events, config)).toEqual(fx);
  });
});
