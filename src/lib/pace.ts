// Ritmo de consumo: compara lo gastado con el tiempo transcurrido de la ventana.

import type { Meter, Spend, UsageReport } from './types';
import { isStaleMeter } from './format';
import { windowEnd, windowStart } from './window';

export interface Pace {
  /** fracción de la ventana transcurrida (0–1) */
  elapsed: number;
  /** fracción consumida (0–1, puede pasar de 1) */
  used: number;
  /** used / elapsed: 1 = vas justo, >1 = vas rápido */
  ratio: number | null;
  /** % estimado al final de la ventana al ritmo actual */
  projected: number | null;
  /** cuándo se agotaría al ritmo actual, si es antes del reinicio */
  exhaustAt: Date | null;
  status: 'ok' | 'fast' | 'over';
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function paceOf(used: number, start: number, end: number, now: number): Pace {
  const span = end - start;
  const elapsed = span > 0 ? clamp((now - start) / span, 0, 1) : 0;
  // Al principio de la ventana la proyección no significa nada.
  const ratio = elapsed >= 0.03 ? used / elapsed : null;
  const projected = ratio != null ? ratio * 100 : null;
  let exhaustAt: Date | null = null;
  if (ratio != null && used > 0 && used < 1 && ratio > 1) {
    const t = start + (span * elapsed) / used;
    if (t < end) exhaustAt = new Date(t);
  }
  const status = used >= 1 || (projected ?? 0) >= 100 ? 'over' : ratio != null && ratio > 1.15 ? 'fast' : 'ok';
  return { elapsed, used, ratio, projected, exhaustAt, status };
}

/** El informe trae medidores; el medidor, no. */
const isReport = (v: UsageReport | Meter): v is UsageReport => 'meters' in v;

/**
 * Ritmo de un medidor con % y ventana conocida (sesión 5 h, semana, mes…).
 *
 * Con el informe delante, un medidor viejo no genera ritmo: lo que se conserva de
 * un ciclo anterior describe el pasado, no el estado de ahora. La regla de
 * obsolescencia la pone el frente (`isStaleMeter`), no este módulo.
 */
export function meterPace(report: UsageReport, m: Meter, now?: number): Pace | null;
export function meterPace(m: Meter, now?: number): Pace | null;
export function meterPace(a: UsageReport | Meter, b?: Meter | number, c?: number): Pace | null {
  const report = isReport(a) ? a : null;
  const m = (report ? b : a) as Meter;
  const now = report ? c ?? Date.now() : typeof b === 'number' ? b : Date.now();
  if (report && isStaleMeter(report, m)) return null;
  if (m.percent == null || !m.windowSeconds) return null;
  const end = windowEnd(m);
  const start = windowStart(m);
  if (end == null || start == null) return null;
  return paceOf(m.percent / 100, start, end, now);
}

/** Ritmo del gasto mensual frente al presupuesto (o proyección del mes si no hay presupuesto). */
export function spendPace(s: Spend, now: number = Date.now()): (Pace & { projectedAmount: number | null }) | null {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const elapsed = clamp((now - start) / (end - start), 0, 1);
  const projectedAmount = elapsed >= 0.03 ? s.amount / elapsed : null;
  if (s.budget && s.budget > 0) {
    return { ...paceOf(s.amount / s.budget, start, end, now), projectedAmount };
  }
  return { elapsed, used: 0, ratio: null, projected: null, exhaustAt: null, status: 'ok', projectedAmount };
}
