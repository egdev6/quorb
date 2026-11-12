import { describe, expect, it } from 'vitest';
import { detectAlerts } from './alerts';
import { formatCompact, formatResetIn, levelFor, mergeReports, peakMeter, reportSummary, sessionsLost, shortLabel, trayTooltip } from './format';
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
  it('shortLabel translates the meters that the backend declares', () => {
    // Los medidores que declara el proveedor llegan con id estable: el frente los
    // traduce por id, sin saber de qué proveedor ni de qué régimen se trata.
    expect(shortLabel('Asignación del periodo', 'allocation', 'es')).toBe('Asignación');
    expect(shortLabel('Asignación del periodo', 'allocation', 'en')).toBe('Allowance');
    expect(shortLabel('Saldo de packs', 'balance', 'es')).toBe('Saldo');
    expect(shortLabel('Saldo de packs', 'balance', 'en')).toBe('Balance');
  });

  it('summarizes the breakdown that the provider declares', () => {
    // El desglose es una lista genérica de rótulo + importe + unidad: el frente no
    // sabe qué son esos rótulos, sólo los muestra.
    const r: UsageReport = {
      ...base,
      breakdown: [{ label: 'deepseek-v4-flash', amount: 24.3, unit: 'credits' }],
    };
    expect(reportSummary(r)).toContain('· deepseek-v4-flash: 24,3 credits');
  });

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
    expect(merged.meters).toEqual(previous.meters);
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
    expect(merged.meters).toEqual(base.meters);
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
