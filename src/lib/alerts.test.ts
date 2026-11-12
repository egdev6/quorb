import { describe, expect, it } from 'vitest';
import { detectAlerts, effectFor, nativeAlertsEnabled, notificationText, windowKey } from './alerts';
import type { AlertEvent } from './alerts';
import { meterPace, paceOf, spendPace } from './pace';
import type { Meter, UsageReport } from './types';

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

/** Informe con los medidores que se le pasan (sin fuente de cuota a nivel de informe). */
const reportWith = (meters: Meter[]): UsageReport => ({ ...rep(0), meters });

/** Medidor de cuota: declara la base contra la que se midió (opaca para el frente). */
const quotaMeter = (pct: number, basis?: string): Meter => ({
  id: 'model:deepseek-v4-flash',
  label: 'deepseek-v4-flash',
  percent: pct,
  used: 955_581_032,
  limit: 1_000_000_000,
  unit: 'tokens',
  resetsAt: '2026-12-05T22:15:31Z',
  windowSeconds: 2592000,
  quotaSource: basis,
});

/**
 * Medidor de cuota con los datos reales de la cuenta de NaN (plan Gentle): la ventana
 * acaba el 5-dic a las 22:15:31 y dura 30 días, así que empezó el 5-nov.
 */
const quotaMeterOf = ({ pct, ...rest }: Partial<Meter> & { pct: number }): Meter => ({
  id: 'model:deepseek-v4-flash',
  label: 'deepseek-v4-flash',
  percent: pct,
  used: 955_581_032,
  limit: 1_000_000_000,
  unit: 'tokens',
  resetsAt: '2026-12-05T22:15:31Z',
  windowSeconds: 2_592_000,
  quotaSource: 'account',
  ...rest,
});

/** Medidor sin base declarada (el propio de NaN, las cabeceras de rate limit…). */
const plainMeter = (id: string, label: string, pct: number): Meter => ({
  id,
  label,
  percent: pct,
  used: 100,
  limit: 500,
  unit: 'tokens',
  resetsAt: null,
  windowSeconds: null,
});

/** Los cuatro datos con los que se identifica cada aviso. */
const eventsOf = (r: { events: AlertEvent[] }) =>
  r.events.map((e) => ({ kind: e.kind, providerId: e.providerId, label: e.label, percent: e.percent }));

/** Sólo los avisos de reinicio (un cambio de base puede disparar además el de «superado»). */
const resetsOf = (r: { events: AlertEvent[] }) => eventsOf(r).filter((e) => e.kind === 'reset');

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

  it('does not report a reset for the meter that changed its quota basis', () => {
    // Mismo id de medidor, mismo consumo y misma fecha de reinicio: solo cambia el
    // denominador (la cuota de la cuenta da paso a la publicada), así que la bajada
    // del porcentaje no es un reinicio de la cuota.
    const prev = reportWith([quotaMeter(95.558, 'account')]);
    const next = reportWith([quotaMeter(31.853, 'published')]);
    expect(eventsOf(detectAlerts([prev], [next], {}, cfg, NOW))).toEqual([]);
  });

  it('reports the reset of a quota meter whose basis changed', () => {
    // La base pasa de «published» a «account»: el porcentaje bajó porque cambió el
    // denominador, pero la ventana avanzó (1-nov → 6-dic) y el consumo absoluto bajó
    // (950 M → 60 M): el reinicio es real y hay que avisar.
    const prev = reportWith([quotaMeterOf({ pct: 95, used: 950_000_000, limit: 1_000_000_000, quotaSource: 'published', resetsAt: '2026-12-01T00:00:00Z' })]);
    const next = reportWith([quotaMeterOf({ pct: 2, used: 60_000_000, limit: 3_000_000_000, quotaSource: 'account', resetsAt: '2027-01-05T22:15:31Z' })]);
    expect(eventsOf(detectAlerts([prev], [next], {}, cfg, NOW))).toEqual([
      { kind: 'reset', providerId: 'claude', label: 'deepseek-v4-flash', percent: 2 },
    ]);
  });

  it('does not report a reset when the basis changed but the window did not advance', () => {
    // Cuenta (ventana del 5-nov) → publicada (ventana del 1-nov): el consumo bajó, pero
    // la ventana nueva no empieza en un día posterior, así que no hay reinicio que afirme.
    const prev = reportWith([quotaMeterOf({ pct: 95.558, quotaSource: 'account' })]);
    const next = reportWith([quotaMeterOf({ pct: 2, used: 60_000_000, limit: 3_000_000_000, quotaSource: 'published', resetsAt: '2026-12-01T00:00:00Z' })]);
    expect(resetsOf(detectAlerts([prev], [next], {}, cfg, NOW))).toEqual([]);
    // Los mismos datos de la cuenta contra la cuota publicada: tampoco hay reinicio.
    const sameConsumption = reportWith([quotaMeterOf({ pct: 31.853, limit: 3_000_000_000, quotaSource: 'published', resetsAt: '2026-12-01T00:00:00Z' })]);
    expect(resetsOf(detectAlerts([reportWith([quotaMeterOf({ pct: 95.558, quotaSource: 'account' })])], [sameConsumption], {}, cfg, NOW))).toEqual([]);
  });

  it('does not report a reset when the window advanced but the consumption did not drop', () => {
    // La ventana avanzó (1-nov → 6-dic) y el porcentaje bajó por el cambio de
    // denominador, pero el consumo absoluto es el mismo: no se puede afirmar el reinicio.
    const prev = reportWith([quotaMeterOf({ pct: 95, used: 950_000_000, limit: 1_000_000_000, quotaSource: 'published', resetsAt: '2026-12-01T00:00:00Z' })]);
    const next = reportWith([quotaMeterOf({ pct: 31.667, used: 950_000_000, limit: 3_000_000_000, quotaSource: 'account', resetsAt: '2027-01-05T22:15:31Z' })]);
    expect(resetsOf(detectAlerts([prev], [next], {}, cfg, NOW))).toEqual([]);
    // Con los datos de la cuenta (mismo consumo, base publicada → cuenta) tampoco.
    const account = reportWith([quotaMeterOf({ pct: 95.558, quotaSource: 'account' })]);
    const published = reportWith([quotaMeterOf({ pct: 31.853, limit: 3_000_000_000, quotaSource: 'published', resetsAt: '2026-12-01T00:00:00Z' })]);
    expect(resetsOf(detectAlerts([published], [account], {}, cfg, NOW))).toEqual([]);
  });

  it('does not report a reset when both readings describe the same period with different hours', () => {
    // Las dos bases describen el mismo periodo (5-nov → 5-dic) con horas distintas:
    // la ventana no avanzó de día, así que no hay reinicio aunque el consumo bajara.
    const prev = reportWith([quotaMeterOf({ pct: 95, used: 950_000_000, limit: 1_000_000_000, quotaSource: 'published', resetsAt: '2026-12-05T00:00:00Z' })]);
    const next = reportWith([quotaMeterOf({ pct: 2, used: 60_000_000, limit: 3_000_000_000, quotaSource: 'account', resetsAt: '2026-12-05T22:15:31Z' })]);
    expect(resetsOf(detectAlerts([prev], [next], {}, cfg, NOW))).toEqual([]);
  });

  it('does not report a reset when the units differ between the readings', () => {
    // Tokens contra créditos: el frente no sabe qué son las unidades, sólo las compara.
    const prev = reportWith([quotaMeterOf({ pct: 95, used: 950_000_000, limit: 1_000_000_000, quotaSource: 'published', resetsAt: '2026-12-01T00:00:00Z' })]);
    const next = reportWith([quotaMeterOf({ pct: 2, used: 60_000_000, limit: 3_000_000_000, unit: 'credits', quotaSource: 'account', resetsAt: '2027-01-05T22:15:31Z' })]);
    expect(resetsOf(detectAlerts([prev], [next], {}, cfg, NOW))).toEqual([]);
  });

  it('does not report a reset when a reading lacks the consumption or the window', () => {
    const prev = reportWith([quotaMeterOf({ pct: 95, used: 950_000_000, limit: 1_000_000_000, quotaSource: 'published', resetsAt: '2026-12-01T00:00:00Z' })]);
    // Sin consumo en la lectura nueva.
    const withoutUsed = reportWith([quotaMeterOf({ pct: 2, used: null, limit: 3_000_000_000, quotaSource: 'account', resetsAt: '2027-01-05T22:15:31Z' })]);
    expect(resetsOf(detectAlerts([prev], [withoutUsed], {}, cfg, NOW))).toEqual([]);
    // Sin ventana en la lectura nueva.
    const withoutWindow = reportWith([quotaMeterOf({ pct: 2, used: 60_000_000, limit: 3_000_000_000, quotaSource: 'account', resetsAt: null, windowSeconds: null })]);
    expect(resetsOf(detectAlerts([prev], [withoutWindow], {}, cfg, NOW))).toEqual([]);
    // Sin ventana en la lectura vieja.
    const oldWithoutWindow = reportWith([quotaMeterOf({ pct: 95, used: 950_000_000, limit: 1_000_000_000, quotaSource: 'published', resetsAt: null, windowSeconds: null })]);
    expect(resetsOf(detectAlerts([oldWithoutWindow], [reportWith([quotaMeterOf({ pct: 2, used: 60_000_000, limit: 3_000_000_000, quotaSource: 'account', resetsAt: '2027-01-05T22:15:31Z' })])], {}, cfg, NOW))).toEqual([]);
  });

  it('reports the reset of the custom meter when the quota meter changes its basis', () => {
    // El medidor de cuota cambia de base y el personalizado baja de 95 % a 2 %:
    // el reinicio es del personalizado, que es independiente de la cuota.
    const prev = reportWith([quotaMeter(95.558, 'account'), plainMeter('custom', 'Consumo', 95)]);
    const next = reportWith([quotaMeter(31.853, 'published'), plainMeter('custom', 'Consumo', 2)]);
    expect(eventsOf(detectAlerts([prev], [next], {}, cfg, NOW))).toEqual([
      { kind: 'reset', providerId: 'claude', label: 'Consumo', percent: 2 },
    ]);
  });

  it('reports the reset of a rate limit meter without a declared basis', () => {
    // Las cabeceras de rate limit no declaran base: se comparan como siempre.
    const prev = reportWith([quotaMeter(95.558, 'account'), plainMeter('rate_requests', 'Peticiones (ventana)', 95)]);
    const next = reportWith([quotaMeter(31.853, 'published'), plainMeter('rate_requests', 'Peticiones (ventana)', 2)]);
    expect(eventsOf(detectAlerts([prev], [next], {}, cfg, NOW))).toEqual([
      { kind: 'reset', providerId: 'claude', label: 'Peticiones (ventana)', percent: 2 },
    ]);
  });

  it('reports the reset of a quota meter that kept its basis', () => {
    const prev = reportWith([quotaMeter(95.558, 'account')]);
    const next = reportWith([quotaMeter(3, 'account')]);
    expect(eventsOf(detectAlerts([prev], [next], {}, cfg, NOW))).toEqual([
      { kind: 'reset', providerId: 'claude', label: 'deepseek-v4-flash', percent: 3 },
    ]);
  });

  it('compares a meter as always when one of the readings has no basis', () => {
    // Sin base en una de las dos lecturas no hay cambio de base: el reinicio se avisa.
    const older = reportWith([quotaMeter(95.558)]);
    const newer = reportWith([quotaMeter(3, 'account')]);
    expect(eventsOf(detectAlerts([older], [newer], {}, cfg, NOW))).toEqual([
      { kind: 'reset', providerId: 'claude', label: 'deepseek-v4-flash', percent: 3 },
    ]);
    const olderWith = reportWith([quotaMeter(95.558, 'account')]);
    const newerWithout = reportWith([quotaMeter(3)]);
    expect(eventsOf(detectAlerts([olderWith], [newerWithout], {}, cfg, NOW))).toEqual([
      { kind: 'reset', providerId: 'claude', label: 'deepseek-v4-flash', percent: 3 },
    ]);
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
