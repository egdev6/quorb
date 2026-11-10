import { describe, expect, it } from 'vitest';
import { detectAlerts, effectFor, nativeAlertsEnabled, notificationText, windowKey } from './alerts';
import { meterPace, paceOf, spendPace } from './pace';
import type { UsageReport } from './types';

const cfg = { threshold: 90, onReset: true };
const rep = (pct: number, resetsAt = '2026-10-06T15:00:00Z', extra: Partial<UsageReport> = {}): UsageReport => ({
  id: 'claude',
  name: 'Claude',
  kind: 'subscription',
  status: 'ok',
  plan: 'Max',
  meters: [{ id: 'session', label: 'Sesión · 5 h', percent: pct, used: null, limit: null, unit: null, resetsAt, windowSeconds: 18000 }],
  spend: null,
  message: null,
  action: null,
  fetchedAt: '',
  ...extra,
});
const NOW = Date.parse('2026-10-06T12:00:00Z');

describe('alerts', () => {
  it('warns once per window when the limit is exceeded', () => {
    let r = detectAlerts([], [rep(85)], {}, cfg, NOW);
    expect(r.events).toHaveLength(0);
    r = detectAlerts([rep(85)], [rep(91)], r.memory, cfg, NOW);
    expect(r.events.map((e) => e.kind).join()).toBe('exceeded');
    r = detectAlerts([rep(91)], [rep(99)], r.memory, cfg, NOW);
    expect(r.events).toHaveLength(0);
  });

  it('warns again in the next window', () => {
    const first = detectAlerts([], [rep(95)], {}, cfg, NOW);
    const next = detectAlerts([rep(95)], [rep(93, '2026-10-06T20:00:00Z')], first.memory, cfg, NOW);
    expect(next.events.map((e) => e.kind).join()).toBe('exceeded');
  });

  it('detects the reset of an exceeded limit', () => {
    const r = detectAlerts([rep(95)], [rep(3, '2026-10-06T20:00:00Z')], {}, cfg, NOW);
    expect(r.events.map((e) => e.kind).join()).toBe('reset');
    // no avisa de reinicios de límites que no se habían superado
    expect(detectAlerts([rep(60)], [rep(3, '2026-10-06T20:00:00Z')], {}, cfg, NOW).events).toHaveLength(0);
    expect(detectAlerts([rep(95)], [rep(3, '2026-10-06T20:00:00Z')], {}, { ...cfg, onReset: false }, NOW).events).toHaveLength(0);
  });

  it('does not report a reset when the quota source changed', () => {
    // Mismo id de medidor, mismo consumo y misma fecha de reinicio: solo cambia el
    // denominador (la cuota de la cuenta da paso a la publicada), así que la bajada
    // del porcentaje no es un reinicio de la cuota.
    const meter = (pct: number, limit: number) => ({
      id: 'model:deepseek-v4-flash',
      label: 'deepseek-v4-flash',
      percent: pct,
      used: 955_581_032,
      limit,
      unit: 'tokens',
      resetsAt: '2026-12-05T22:15:31Z',
      windowSeconds: 2592000,
    });
    const prev: UsageReport = { ...rep(0), quotaSource: 'account', meters: [meter(95.558, 1_000_000_000)] };
    const next: UsageReport = { ...rep(0), quotaSource: 'published', meters: [meter(31.853, 3_000_000_000)] };
    const r = detectAlerts([prev], [next], {}, cfg, NOW);
    expect(r.events.map((e) => e.kind)).toEqual([]);
    // Un reinicio de verdad con la misma fuente sigue avisando.
    const sameSource = detectAlerts([prev], [{ ...next, quotaSource: 'account' }], {}, cfg, NOW);
    expect(sameSource.events.map((e) => e.kind)).toEqual(['reset']);
  });

  it('ignores stale or failed reports', () => {
    expect(detectAlerts([], [rep(99, undefined, { stale: true })], {}, cfg, NOW).events).toHaveLength(0);
    expect(detectAlerts([], [rep(99, undefined, { status: 'error' })], {}, cfg, NOW).events).toHaveLength(0);
  });

  it('keys alerts by meter id: a relabelled meter neither re-alerts nor loses its reset', () => {
    const relabel = (r: UsageReport, label: string): UsageReport => ({ ...r, meters: r.meters.map((m) => ({ ...m, label })) });
    const first = detectAlerts([], [rep(95)], {}, cfg, NOW);
    expect(first.events).toHaveLength(1);
    // Same window and same id, translated label: already alerted, no phantom repeat.
    const translated = relabel(rep(96), 'Session · 5 h');
    expect(detectAlerts([rep(95)], [translated], first.memory, cfg, NOW).events).toHaveLength(0);
    // The reset of the exceeded limit is still found although the label differs between cycles.
    const reset = detectAlerts([rep(95)], [relabel(rep(3, '2026-10-06T20:00:00Z'), 'Session · 5 h')], {}, cfg, NOW);
    expect(reset.events.map((e) => e.kind)).toEqual(['reset']);
    expect(reset.events[0].label).toBe('Session · 5 h');
  });

  it('does not merge different meter ids that happen to share a label', () => {
    const two = (a: string, b: string): UsageReport => ({
      ...rep(95),
      meters: [
        { ...rep(95).meters[0], id: a, label: 'Same' },
        { ...rep(95).meters[0], id: b, label: 'Same' },
      ],
    });
    expect(detectAlerts([], [two('weekly', 'weekly_opus')], {}, cfg, NOW).events).toHaveLength(2);
  });

  it('falls back to the label for meters without an id', () => {
    const legacy = (pct: number, resetsAt?: string): UsageReport => ({
      ...rep(pct, resetsAt),
      meters: rep(pct, resetsAt).meters.map((m) => ({ ...m, id: '' })),
    });
    const first = detectAlerts([], [legacy(95)], {}, cfg, NOW);
    expect(first.events).toHaveLength(1);
    expect(detectAlerts([legacy(95)], [legacy(97)], first.memory, cfg, NOW).events).toHaveLength(0);
    expect(detectAlerts([legacy(95)], [legacy(3, '2026-10-06T20:00:00Z')], {}, cfg, NOW).events.map((e) => e.kind)).toEqual(['reset']);
  });

  it('does not repeat an exceeded alert already remembered under the pre-id label key', () => {
    const w = windowKey('2026-10-06T15:00:00Z');
    const legacyMemory = { ['claude|Sesión · 5 h|' + w]: 'exceeded' } as const;
    expect(detectAlerts([rep(95)], [rep(96)], legacyMemory, cfg, NOW).events).toHaveLength(0);
  });

  it('picks the effect and moment', () => {
    const fx = { exceededEffect: 'glow', resetEffect: 'custom' } as const;
    const exceeded = detectAlerts([], [rep(99)], {}, cfg, NOW).events;
    expect(effectFor(exceeded, fx)?.effect).toBe('glow');
    expect(effectFor(exceeded, fx)?.moment).toBe('exceeded');
    const reset = detectAlerts([rep(95)], [rep(3, '2026-10-06T20:00:00Z')], {}, cfg, NOW).events;
    expect(effectFor(reset, fx)?.moment).toBe('reset');
    expect(effectFor([], fx)).toBeNull();
    expect(notificationText(exceeded)?.title).toBe('Límite superado');
    expect(notificationText(reset)?.title).toBe('Límite reiniciado');
  });
});

describe('nativeAlertsEnabled', () => {
  it('exige el interruptor maestro y el aviso nativo', () => {
    expect(nativeAlertsEnabled({ enabled: false, native: true })).toBe(false);
    expect(nativeAlertsEnabled({ enabled: true, native: false })).toBe(false);
    expect(nativeAlertsEnabled({ enabled: true, native: true })).toBe(true);
    // Sin configuración no se notifica (antes `native !== false` sí lo hacía).
    expect(nativeAlertsEnabled(undefined)).toBe(false);
    expect(nativeAlertsEnabled(null)).toBe(false);
  });
});

describe('pace', () => {
  it('computes ratio, projection and exhaustion', () => {
    // 50 % gastado con el 25 % del tiempo → ritmo 2×, se agota a mitad de ventana
    const p = paceOf(0.5, 0, 100, 25);
    expect(p.ratio).toBe(2);
    expect(p.projected).toBe(200);
    expect(p.exhaustAt?.getTime()).toBe(50);
    expect(p.status).toBe('over');
    expect(paceOf(0.2, 0, 100, 50).status).toBe('ok');
  });

  it('uses the meter window', () => {
    // reinicio a las 15:00, ventana 5 h → empezó a las 10:00; ahora 12:00 = 40 %
    const p = meterPace(rep(20).meters[0], NOW)!;
    expect(p.elapsed).toBe(0.4);
    expect(p.status).toBe('ok');
  });

  it('projects monthly spend', () => {
    const mid = Date.UTC(2026, 9, 16, 12); // 15,5 de 31 días = mitad de mes
    const p = spendPace({ amount: 30, currency: 'USD', periodLabel: '', budget: 50 }, mid)!;
    expect(Math.round(p.projectedAmount!)).toBe(60);
    expect(p.status).toBe('over');
  });
});
