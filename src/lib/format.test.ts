import { describe, expect, it } from 'vitest';
import { detectAlerts } from './alerts';
import { currentMeters, formatCompact, formatResetIn, hasStaleData, isStaleMeter, isStaleSpend, levelFor, mergeReports, peakMeter, reportSummary, sessionsLost, shortLabel, trayTooltip } from './format';
import { meterPace } from './pace';
import type { Meter, UsageReport } from './types';

const base: UsageReport = {
  id: 'claude',
  name: 'Claude',
  kind: 'subscription',
  status: 'ok',
  plan: 'Max',
  meters: [
    { id: '', label: 'Sesión · 5 h', percent: 37, used: null, limit: null, unit: null, resetsAt: null, windowSeconds: null },
    { id: '', label: 'Semana · todos', percent: 81, used: null, limit: null, unit: null, resetsAt: null, windowSeconds: null },
  ],
  spend: null,
  message: null,
  action: null,
  fetchedAt: '2026-10-06T10:00:00Z',
};

describe('localized meter shorts, reset times and summary (T2c-S1)', () => {
  it('shortLabel follows the locale by meter id', () => {
    expect(shortLabel('Semana · todos', 'weekly', 'en')).toBe('Week');
    expect(shortLabel('Presupuesto mensual', 'budget_monthly', 'en')).toBe('Budget');
    expect(shortLabel('Peticiones (ventana)', 'rate_requests', 'en')).toBe('Requests');
    expect(shortLabel('Semana · todos', 'weekly', 'es')).toBe('Semana');
    expect(shortLabel('Presupuesto mensual', 'budget_monthly', 'es')).toBe('Presupuesto');
    // Datos antiguos sin id: la etiqueta es dato y se conserva tal cual.
    expect(shortLabel('Sesión · 5 h', '', 'en')).toBe('Sesión 5 h');
  });

  it('formatResetIn follows the locale', () => {
    const now = new Date('2026-10-06T10:00:00Z');
    expect(formatResetIn('2026-10-06T10:45:00Z', now, 'en')).toBe('in 45 min');
    expect(formatResetIn('2026-10-06T12:13:00Z', now, 'en')).toBe('in 2 h 13 min');
    expect(formatResetIn('2026-10-09T14:00:00Z', now, 'en')).toBe('in 3 d 4 h');
    expect(formatResetIn('2026-10-06T09:00:00Z', now, 'en')).toBe('now');
    expect(formatResetIn('2026-10-06T10:45:00Z', now, 'es')).toBe('en 45 min');
    expect(formatResetIn('2026-10-06T09:00:00Z', now, 'es')).toBe('ahora');
  });

  it('reportSummary localizes the reset suffix', () => {
    const r: UsageReport = {
      ...base,
      meters: [{ id: 'weekly', label: 'Semana · todos', percent: 50, used: null, limit: null, unit: null, resetsAt: '2026-10-06T10:45:00Z', windowSeconds: null }],
    };
    const now = new Date('2026-10-06T10:00:00Z');
    expect(reportSummary(r, now, 'en')).toContain('(resets in 45 min)');
    expect(reportSummary(r, now, 'es')).toContain('(reinicia en 45 min)');
  });
});

describe('format', () => {
  it('formats reset distance', () => {
    const now = new Date('2026-10-06T10:00:00Z');
    expect(formatResetIn('2026-10-06T10:45:00Z', now)).toBe('en 45 min');
    expect(formatResetIn('2026-10-06T12:13:00Z', now)).toBe('en 2 h 13 min');
    expect(formatResetIn('2026-10-09T14:00:00Z', now)).toBe('en 3 d 4 h');
    expect(formatResetIn('2026-10-06T09:00:00Z', now)).toBe('ahora');
    expect(formatResetIn(null, now)).toBeNull();
  });

  it('formats big numbers', () => {
    expect(formatCompact(3_000_000_000)).toBe('3 B');
    expect(formatCompact(400_000_000)).toBe('400 M');
  });

  it('classifies levels', () => {
    expect(levelFor(10)).toBe('low');
    expect(levelFor(75)).toBe('high');
    expect(levelFor(95)).toBe('max');
  });

  it('picks the peak meter', () => {
    expect(peakMeter(base)?.percent).toBe(81);
  });

  it('keeps stale data when a cycle fails', () => {
    const failed: UsageReport = { ...base, status: 'warning', meters: [], message: '429' };
    const [merged] = mergeReports([base], [failed]);
    expect(merged.stale).toBe(true);
    expect(merged.meters).toHaveLength(2);
    expect(merged.message).toBe('429');
  });

  it('keeps the whole previous report when the failed one brings no meter', () => {
    const previous: UsageReport = { ...base, plan: 'Gentle', spend: { amount: 12, currency: 'USD', periodLabel: 'Diciembre', budget: 100 } };
    const failed: UsageReport = { ...base, status: 'error', meters: [], message: 'sin cuota', plan: null, spend: null };
    const [merged] = mergeReports([previous], [failed]);
    expect(merged.stale).toBe(true);
    // Los datos se conservan tal cual; además cada medidor lleva la fecha de su lectura.
    expect(merged.meters.map((m) => ({ ...m, readAt: undefined }))).toEqual(previous.meters);
    expect(merged.meters.every((m) => m.readAt === previous.fetchedAt)).toBe(true);
    expect(merged.plan).toBe('Gentle');
    expect(merged.spend).toEqual(previous.spend);
  });

  it('keeps the meters that a failed report does not bring', () => {
    // La cuota de la cuenta falló, pero las cabeceras de rate limit vinieron: el informe
    // llega MIXTO y el medidor de cuota no puede desaparecer sin más.
    const quota: Meter = {
      id: 'model:deepseek-v4-flash',
      label: 'deepseek-v4-flash',
      percent: 95.558,
      used: 955_581_032,
      limit: 1_000_000_000,
      unit: 'tokens',
      resetsAt: '2026-12-05T22:15:31Z',
      windowSeconds: 2_592_000,
      quotaSource: 'account',
    };
    const previous: UsageReport = {
      ...base,
      status: 'ok',
      meters: [quota],
      plan: 'Gentle',
      spend: { amount: 12, currency: 'USD', periodLabel: 'Diciembre', budget: 100 },
    };
    const failed: UsageReport = {
      ...base,
      status: 'warning',
      message: 'cuota no disponible',
      plan: null,
      spend: null,
      meters: [
        { id: 'custom', label: 'Consumo', percent: 10, used: 10, limit: 100, unit: 'tokens', resetsAt: null, windowSeconds: null },
        { id: 'rate_requests', label: 'Peticiones (ventana)', percent: 20, used: 20, limit: 100, unit: 'req', resetsAt: null, windowSeconds: null },
      ],
    };
    const [merged] = mergeReports([previous], [failed]);
    // El informe MIXTO no queda desactualizado entero: trae datos frescos.
    expect(merged.stale).toBeUndefined();
    expect(merged.meters.map((m) => m.id)).toEqual(['custom', 'rate_requests', 'model:deepseek-v4-flash']);
    expect(merged.message).toBe('cuota no disponible');
    // El informe nuevo manda; lo que no trae se conserva del anterior.
    expect(merged.plan).toBe('Gentle');
    // El gasto NO se conserva: es una lectura, y arrastrarlo mostraría datos viejos
    // sin marcar (la base no lo arrastraba).
    expect(merged.spend).toBeNull();
    // Los medidores frescos están por debajo del umbral y el conservado va marcado
    // como viejo: este ciclo no tiene nada que avisar.
    expect(detectAlerts([previous], [merged], {}, { threshold: 90, onReset: true }).events).toHaveLength(0);
  });

  it('marks each kept meter as stale, not the whole mixed report', () => {
    // Ciclo MIXTO: la cuota de la cuenta no se pudo actualizar, pero llegaron las
    // cabeceras de rate limit. Lo viejo se conserva MARCADO MEDIDOR A MEDIDOR: el
    // informe no queda desactualizado entero, porque tiene datos frescos.
    const quota: Meter = {
      id: 'model:deepseek-v4-flash',
      label: 'deepseek-v4-flash',
      percent: 95.558,
      used: 955_581_032,
      limit: 1_000_000_000,
      unit: 'tokens',
      resetsAt: '2026-12-05T22:15:31Z',
      windowSeconds: 2_592_000,
      quotaSource: 'account',
    };
    const previous: UsageReport = { ...base, status: 'ok', meters: [quota] };
    const failed: UsageReport = {
      ...base,
      status: 'warning',
      message: 'cuota no disponible',
      meters: [
        { id: 'rate_requests', label: 'Peticiones (ventana)', percent: 95, used: 95, limit: 100, unit: 'req', resetsAt: null, windowSeconds: null },
      ],
    };
    const [merged] = mergeReports([previous], [failed]);
    // El informe NO queda desactualizado: si lo quedara, los avisos lo saltarían entero.
    expect(merged.stale).toBeUndefined();
    const kept = merged.meters.find((m) => m.id === 'model:deepseek-v4-flash')!;
    const fresh = merged.meters.find((m) => m.id === 'rate_requests')!;
    // El medidor conservado es el viejo: va marcado.
    expect(kept.stale).toBe(true);
    // El medidor fresco no lleva marca: sus datos son de este ciclo.
    expect(fresh.stale).toBeUndefined();
    // Y el fresco sigue avisando aunque su compañero sea viejo.
    const { events } = detectAlerts([previous], [merged], {}, { threshold: 90, onReset: true });
    expect(events.map((e) => e.kind)).toEqual(['exceeded']);
    expect(events[0].meterId).toBe('rate_requests');
  });

  it('does not carry the previous daily series nor the spend into a mixed report', () => {
    // La serie diaria y el gasto son lecturas: si este ciclo no los trae, no se
    // muestran. Arrastrarlos del ciclo anterior mostraría datos viejos sin marcar,
    // que es justo lo que se pidió evitar con la cuota.
    const quota: Meter = {
      id: 'model:deepseek-v4-flash',
      label: 'deepseek-v4-flash',
      percent: 95.558,
      used: 955_581_032,
      limit: 1_000_000_000,
      unit: 'tokens',
      resetsAt: '2026-12-05T22:15:31Z',
      windowSeconds: 2_592_000,
      quotaSource: 'account',
    };
    const previous: UsageReport = {
      ...base,
      status: 'ok',
      meters: [quota],
      daily: [{ date: '2026-10-05', value: 5 }],
      spend: { amount: 12, currency: 'USD', periodLabel: 'Octubre', budget: 100 },
    };
    const failed: UsageReport = {
      ...base,
      status: 'warning',
      message: 'cuota no disponible',
      meters: [{ id: 'rate_requests', label: 'Peticiones (ventana)', percent: 20, used: 20, limit: 100, unit: 'req', resetsAt: null, windowSeconds: null }],
    };
    const [merged] = mergeReports([previous], [failed]);
    // El medidor de cuota sí se conserva (marcado como viejo)...
    expect(merged.meters.find((m) => m.id === quota.id)?.stale).toBe(true);
    // ...pero la serie diaria y el gasto no: si este ciclo no los trae, no se muestran.
    expect(merged.daily).toBeUndefined();
    expect(merged.spend).toBeNull();
  });

  it('keeps the whole report stale when the failed cycle brings no meter', () => {    // Aquí no hay nada fresco: todo lo que se ve es viejo, así que el informe entero
    // sigue marcado como desactualizado y los avisos lo saltan entero.
    const failed: UsageReport = { ...base, status: 'error', meters: [], message: 'sin cuota', plan: null, spend: null };
    const [merged] = mergeReports([base], [failed]);
    expect(merged.stale).toBe(true);
    expect(merged.meters.map((m) => ({ ...m, readAt: undefined }))).toEqual(base.meters);
    expect(merged.meters.every((m) => m.stale !== true)).toBe(true);
  });

  it('does not mark a report stale when the failed one keeps every meter', () => {
    // El informe nuevo trae todos sus medidores: no hay nada viejo que conservar, así que
    // el informe NO queda desactualizado (un `stale` haría que los avisos lo saltaran
    // entero, y ese ciclo perdería su aviso de límite superado).
    const failed: UsageReport = { ...base, status: 'warning', message: '429' };
    const [merged] = mergeReports([base], [failed]);
    expect(merged.stale).toBeUndefined();
    expect(merged.meters).toHaveLength(2);
    // Y ese ciclo sigue avisando con normalidad.
    const exceeded = detectAlerts([base], [{ ...failed, meters: [{ ...base.meters[0], percent: 95 }] }], {}, { threshold: 90, onReset: true });
    expect(exceeded.events.map((e) => e.kind)).toContain('exceeded');
  });

  it('keeps the last data when the session expires', () => {
    const lost: UsageReport = { ...base, status: 'needsLogin', meters: [], action: 'login', message: 'caducada' };
    const [merged] = mergeReports([base], [lost]);
    expect(merged).toMatchObject({ status: 'needsLogin', action: 'login', message: 'caducada', stale: true });
    expect(merged.meters).toHaveLength(2);
    expect(mergeReports([], [lost])[0].meters).toHaveLength(0);
  });

  it('detects sessions that were just lost', () => {
    const lost: UsageReport = { ...base, status: 'needsLogin', meters: [] };
    expect(sessionsLost([base], [lost]).map((r) => r.id)).toEqual(['claude']);
    expect(sessionsLost([lost], [lost])).toEqual([]);
    expect(sessionsLost([], [lost])).toEqual([]);
  });

  it('shortens ring labels', () => {
    expect(shortLabel('Sesión · 5 h')).toBe('Sesión 5 h');
    expect(shortLabel('Semana · todos')).toBe('Semana');
    expect(shortLabel('Algo nuevo')).toBe('Algo nuevo');
  });

  it('shortens ring labels by stable id, whatever the label text', () => {
    const cases: [string, string][] = [
      ['weekly', 'Semana'],
      ['weekly_opus', 'Opus'],
      ['weekly_sonnet', 'Sonnet'],
      ['weekly_apps', 'Apps'],
      ['budget_monthly', 'Presupuesto'],
      ['rate_requests', 'Peticiones'],
      ['rate_tokens', 'Tokens'],
      ['extra_usage', 'Extra'],
    ];
    for (const [id, short] of cases) expect(shortLabel('Translated label', id)).toBe(short);
    expect(shortLabel('Sesión · 5 h', 'session')).toBe('Sesión 5 h');
    expect(shortLabel('Sesión · 3 h', 'session')).toBe('Sesión 3 h');
    // The codex weekly meter is labelled just «Semana».
    expect(shortLabel('Semana', 'weekly')).toBe('Semana');
  });

  it('falls back to the label when the id is empty or unknown', () => {
    expect(shortLabel('Semana · Opus', '')).toBe('Opus');
    expect(shortLabel('Semana · Opus')).toBe('Opus');
    expect(shortLabel('Semana · Opus', 'something_new')).toBe('Opus');
    expect(shortLabel('Gemini 2.5 Pro', 'model:gemini-2.5-pro')).toBe('Gemini 2.5 Pro');
    expect(shortLabel('Algo nuevo', 'custom')).toBe('Algo nuevo');
  });

  it('builds tray tooltip', () => {
    expect(trayTooltip([base])).toBe('Claude: 81%');
  });
});

// T31 (S33 caso 3, S34): la presentación del dato obsoleto. Decisión del Juicio: O4+O3.
// Un medidor obsoleto no participa de ningún cálculo de estado actual, pero sigue
// viéndose en el detalle, atenuado y con la fecha de su última lectura.
describe('stale data is never presented as the current state (T31)', () => {
  const freshMeter = (over: Partial<Meter> = {}): Meter => ({
    id: 'rate_requests',
    label: 'Peticiones (ventana)',
    percent: 20,
    used: 20,
    limit: 100,
    unit: 'req',
    resetsAt: null,
    windowSeconds: null,
    ...over,
  });
  // El medidor conservado de un ciclo anterior: el del régimen que ya no aplica.
  const keptMeter = (over: Partial<Meter> = {}): Meter => ({
    id: 'model:deepseek-v4-flash',
    label: 'deepseek-v4-flash',
    percent: 95.558,
    used: 955_581_032,
    limit: 1_000_000_000,
    unit: 'tokens',
    resetsAt: '2026-12-05T22:15:31Z',
    windowSeconds: 2_592_000,
    quotaSource: 'account',
    ...over,
  });

  it('marks every meter of a stale report as stale, not only the marked ones', () => {
    const report: UsageReport = { ...base, stale: true };
    expect(isStaleMeter(report, report.meters[0])).toBe(true);
    expect(currentMeters(report)).toEqual([]);
    expect(hasStaleData(report)).toBe(true);
  });

  it('marks a single stale meter inside a fresh report', () => {
    const report: UsageReport = { ...base, meters: [freshMeter(), keptMeter({ stale: true })] };
    expect(isStaleMeter(report, report.meters[1])).toBe(true);
    expect(isStaleMeter(report, report.meters[0])).toBe(false);
    expect(currentMeters(report)).toEqual([report.meters[0]]);
    expect(hasStaleData(report)).toBe(true);
  });

  it('never picks a stale meter as the peak', () => {
    const report: UsageReport = { ...base, meters: [keptMeter({ stale: true, percent: 100 }), freshMeter({ percent: 95 })] };
    expect(peakMeter(report)?.percent).toBe(95);
  });

  it('has no peak at all when only stale data is left (C1)', () => {
    const report: UsageReport = { ...base, meters: [keptMeter({ stale: true, percent: 100 })] };
    expect(peakMeter(report)).toBeNull();
    // Un informe entero conservado tampoco deja pico: sus medidores son viejos.
    const whole: UsageReport = { ...base, stale: true };
    expect(peakMeter(whole)).toBeNull();
  });

  it('does not present the stale peak in the tray tooltip (C1)', () => {
    const report: UsageReport = { ...base, name: 'OpenCode Go', meters: [keptMeter({ stale: true, percent: 100 })] };
    expect(trayTooltip([report])).toBe('OpenCode Go: —');
    // Un proveedor sin medidores sigue mostrando su gasto: no hay nada viejo.
    const spendOnly: UsageReport = { ...base, name: 'OpenRouter', meters: [], spend: { amount: 12, currency: 'USD', periodLabel: 'Diciembre', budget: 100 } };
    expect(trayTooltip([spendOnly])).toMatch(/^OpenRouter: 12,00/);
  });

  it('computes the pace only for the current meters', () => {
    const window = { resetsAt: new Date(Date.now() + 302400000).toISOString(), windowSeconds: 604800 };
    const report: UsageReport = {
      ...base,
      meters: [freshMeter({ ...window }), keptMeter({ ...window, stale: true })],
    };
    expect(meterPace(report, report.meters[0])).not.toBeNull();
    expect(meterPace(report, report.meters[1])).toBeNull();
  });

  it('does not present the meter kept from another regime as current (C3)', () => {
    // El escenario real del informe MIXTO: la cuota de la cuenta se cayó y el informe
    // conserva el medidor del régimen anterior, marcado como viejo.
    const previous: UsageReport = { ...base, status: 'ok', meters: [keptMeter()] };
    const failed: UsageReport = { ...base, status: 'warning', message: 'cuota no disponible', meters: [freshMeter()] };
    const [merged] = mergeReports([previous], [failed]);
    // Lo viejo se conserva…
    expect(merged.meters.map((m) => m.id)).toEqual(['rate_requests', 'model:deepseek-v4-flash']);
    expect(merged.meters[1].stale).toBe(true);
    // …pero no manda en el estado actual.
    expect(currentMeters(merged).map((m) => m.id)).toEqual(['rate_requests']);
    expect(peakMeter(merged)?.id).toBe('rate_requests');
  });

  it('stamps the kept meter with the reading date of the report it comes from (R4)', () => {
    const previous: UsageReport = { ...base, status: 'ok', fetchedAt: '2026-11-10T08:00:00Z', meters: [keptMeter()] };
    const failed: UsageReport = { ...base, status: 'warning', message: 'cuota no disponible', fetchedAt: '2026-11-12T08:00:00Z', meters: [freshMeter()] };
    const [merged] = mergeReports([previous], [failed]);
    const kept = merged.meters.find((m) => m.id === 'model:deepseek-v4-flash')!;
    // El medidor conserva la fecha de SU lectura; el informe nuevo manda con la suya.
    expect(kept.readAt).toBe('2026-11-10T08:00:00Z');
    expect(merged.fetchedAt).toBe('2026-11-12T08:00:00Z');
  });

  it('stamps the whole kept report with its own reading date (R4)', () => {
    const previous: UsageReport = { ...base, fetchedAt: '2026-11-10T08:00:00Z' };
    const failed: UsageReport = { ...base, status: 'error', meters: [], message: 'sin cuota', fetchedAt: '2026-11-12T08:00:00Z' };
    const [merged] = mergeReports([previous], [failed]);
    expect(merged.stale).toBe(true);
    expect(merged.meters.every((m) => m.readAt === '2026-11-10T08:00:00Z')).toBe(true);
  });
});

// T31b (S33 caso 2, C-6): el backend declara el régimen de facturación en el informe y
// el frente sólo compara si cambió. Un aviso de «suscripción inactiva» en una cuenta
// que cambió de régimen NO es un fallo de lectura: los topes del régimen anterior ya no
// aplican, así que no se resucitan. El texto del régimen es opaco para el frente.
describe('a different billing regime does not bring the old meters back (T31b)', () => {
  const modelQuotaMeter: Meter = {
    id: 'model:deepseek-v4-flash',
    label: 'deepseek-v4-flash',
    percent: 95.558,
    used: 955_581_032,
    limit: 1_000_000_000,
    unit: 'tokens',
    resetsAt: '2026-12-05T22:15:31Z',
    windowSeconds: 2_592_000,
    quotaSource: 'account',
  };
  const rateMeter: Meter = {
    id: 'rate_requests',
    label: 'Peticiones (ventana)',
    percent: 20,
    used: 20,
    limit: 100,
    unit: 'req',
    resetsAt: null,
    windowSeconds: null,
  };

  it('does not resurrect the meters of the previous regime (credits account)', () => {
    // El caso del owner: un informe de una cuenta con créditos (llega como aviso)
    // no revive el medidor por modelo de la cuenta de asignación por modelo.
    const previous: UsageReport = { ...base, status: 'ok', billingRegime: 'model-quota', meters: [modelQuotaMeter] };
    const credits: UsageReport = { ...base, status: 'warning', billingRegime: 'credits', message: 'suscripción inactiva', meters: [] };
    const [merged] = mergeReports([previous], [credits]);
    // El medidor del régimen anterior no aparece.
    expect(merged.meters).toEqual([]);
    // Y no queda nada viejo que conservar: el informe no se marca desactualizado.
    expect(merged.stale).toBeUndefined();
    // El mensaje del ciclo nuevo manda.
    expect(merged.message).toBe('suscripción inactiva');
  });

  it('does not keep the missing meters of the previous regime in a mixed report', () => {
    // El informe MIXTO: llegan los medidores frescos (cabeceras de rate limit) pero
    // los del régimen anterior no se conservan.
    const previous: UsageReport = { ...base, status: 'ok', billingRegime: 'model-quota', meters: [modelQuotaMeter] };
    const credits: UsageReport = { ...base, status: 'warning', billingRegime: 'credits', message: 'suscripción inactiva', meters: [rateMeter] };
    const [merged] = mergeReports([previous], [credits]);
    expect(merged.meters.map((m) => m.id)).toEqual(['rate_requests']);
    expect(merged.meters[0].stale).toBeUndefined();
  });

  it('keeps the old data when the regime is the same', () => {
    // Mismo régimen: el aviso es un fallo de lectura y los datos anteriores se
    // conservan como estaban (desactualizados, con su fecha).
    const previous: UsageReport = { ...base, status: 'ok', billingRegime: 'model-quota', meters: [modelQuotaMeter] };
    const failed: UsageReport = { ...base, status: 'warning', billingRegime: 'model-quota', message: 'cuota no disponible', meters: [] };
    const [merged] = mergeReports([previous], [failed]);
    expect(merged.stale).toBe(true);
    expect(merged.meters.map((m) => m.id)).toEqual(['model:deepseek-v4-flash']);
    expect(merged.meters[0].readAt).toBe(previous.fetchedAt);
  });

  it('keeps the old data when a report declares no regime', () => {
    // Un proveedor que no declara régimen (o un informe sin régimen): no hay
    // comparación posible, así que el comportamiento es el de siempre.
    const previous: UsageReport = { ...base, status: 'ok', meters: [modelQuotaMeter] };
    const failed: UsageReport = { ...base, status: 'warning', message: 'sin cuota', meters: [] };
    const [merged] = mergeReports([previous], [failed]);
    expect(merged.stale).toBe(true);
    expect(merged.meters.map((m) => m.id)).toEqual(['model:deepseek-v4-flash']);
  });

  it('does not keep the old data when only the new report declares a regime', () => {
    // El informe nuevo declara el régimen y el anterior NO declara ninguno: los
    // medidores del anterior no se pueden atribuir al régimen vigente, así que no
    // se conservan (no se resucitan los topes de un régimen que ya no aplica).
    const previous: UsageReport = { ...base, status: 'ok', meters: [modelQuotaMeter] };
    const failed: UsageReport = { ...base, status: 'warning', billingRegime: 'credits', message: 'sin cuota', meters: [] };
    const [merged] = mergeReports([previous], [failed]);
    expect(merged.meters).toEqual([]);
    // Y no queda nada viejo que conservar: el informe no se marca desactualizado.
    expect(merged.stale).toBeUndefined();
    // El régimen que declara el informe nuevo es el que manda.
    expect(merged.billingRegime).toBe('credits');
  });

  it('keeps the old data when only the previous report declares a regime', () => {
    // Lectura fallida: el informe nuevo NO declara régimen, así que no hay
    // comparación posible y el último ciclo correcto se sigue guardando.
    const previous: UsageReport = { ...base, status: 'ok', billingRegime: 'model-quota', meters: [modelQuotaMeter] };
    const failed: UsageReport = { ...base, status: 'warning', message: 'sin cuota', meters: [] };
    const [merged] = mergeReports([previous], [failed]);
    expect(merged.stale).toBe(true);
    expect(merged.meters.map((m) => m.id)).toEqual(['model:deepseek-v4-flash']);
    expect(merged.meters[0].readAt).toBe(previous.fetchedAt);
  });
});

// F1: el gasto conservado es un dato viejo. Se puede ver (la información es real),
// pero nunca se presenta como el estado de ahora y siempre va marcado.
describe('the kept spend is never presented as the current state (F1)', () => {
  const spend = { amount: 12, currency: 'USD', periodLabel: 'Diciembre', budget: 100 };
  // Un informe MIXTO: el medidor es viejo, el gasto es de este ciclo.
  const mixed: UsageReport = { ...base, meters: [{ ...base.meters[0], stale: true }], spend };

  it('marks the spend as stale only when the whole report is stale', () => {
    expect(isStaleSpend({ ...base, stale: true })).toBe(true);
    expect(isStaleSpend(base)).toBe(false);
    // Un medidor viejo no vuelve viejo el gasto: el gasto es de este ciclo.
    expect(isStaleSpend(mixed)).toBe(false);
  });

  it('shows the fresh spend of a mixed report in the tray tooltip', () => {
    // El gasto viene del informe nuevo: es fresco y se ve (antes el tooltip lo
    // escondía de más, porque miraba si el informe tenía ALGÚN medidor viejo).
    expect(trayTooltip([mixed])).toMatch(/^Claude: 12,00/);
  });

  it('does not show the kept spend of a stale report in the tray tooltip', () => {
    const whole: UsageReport = { ...base, stale: true, spend };
    expect(trayTooltip([whole])).toBe('Claude: —');
  });
});

// F3: el resumen que se copia no afirma el estado viejo como vigente.
describe('the copied summary never claims the old state is current (F3)', () => {
  const now = new Date('2026-11-13T08:00:00Z');

  it('marks the stale meters with the cached chip and their reading date', () => {
    const report: UsageReport = {
      ...base,
      meters: [
        { id: 'rate_requests', label: 'Peticiones (ventana)', percent: 20, used: null, limit: null, unit: null, resetsAt: null, windowSeconds: null },
        { id: 'model:deepseek-v4-flash', label: 'deepseek-v4-flash', percent: 95, used: null, limit: null, unit: null, resetsAt: null, windowSeconds: null, stale: true, readAt: '2026-11-12T08:00:00Z' },
      ],
    };
    const lines = reportSummary(report, now, 'es').split('\n');
    const fresh = lines.find((l) => l.includes('Peticiones'))!;
    const old = lines.find((l) => l.includes('deepseek-v4-flash'))!;
    // El medidor viejo va marcado, con la fecha de su última lectura.
    expect(old).toContain('caché');
    expect(old).toContain('12 nov');
    // El vigente, no.
    expect(fresh).not.toContain('caché');
  });

  it('marks the meters of a whole kept report as cached', () => {
    // Informe entero conservado: sus medidores son viejos aunque no lleven la marca.
    const report: UsageReport = { ...base, stale: true, fetchedAt: '2026-11-12T08:00:00Z' };
    const summary = reportSummary(report, now, 'es');
    expect(summary).toContain('caché');
    expect(summary).toContain('12 nov');
  });

  it('marks the kept spend as cached', () => {
    const report: UsageReport = {
      ...base,
      stale: true,
      fetchedAt: '2026-11-12T08:00:00Z',
      spend: { amount: 12, currency: 'USD', periodLabel: 'Diciembre', budget: 100 },
    };
    const line = reportSummary(report, now, 'es').split('\n').find((l) => l.includes('Diciembre'))!;
    expect(line).toContain('caché');
    expect(line).toContain('12 nov');
  });
});
