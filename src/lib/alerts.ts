// Avisos en dos momentos:
//   1. «exceeded»: un límite pasa del umbral configurado (por defecto 90 %).
//   2. «reset»: ese límite, que se había superado, se reinicia (nueva ventana o baja de golpe).
// Se recuerda qué se ha avisado por ventana para no repetir (la memoria se guarda en el widget).

import type { AlertMoment, AlertsConfig, Effect, Meter, UsageReport } from './types';
import { windowEnd, windowStart } from './window';

/**
 * ¿Debe el widget lanzar avisos nativos? Requiere el interruptor maestro
 * (`enabled`) y que `native` no esté desactivado. Sin configuración, no.
 */
export function nativeAlertsEnabled(a: Pick<AlertsConfig, 'enabled' | 'native'> | null | undefined): boolean {
  return !!a?.enabled && a.native !== false;
}

export interface AlertEvent {
  kind: AlertMoment;
  providerId: string;
  providerName: string;
  /** Identidad existente del medidor y ventana; no añade memoria de email. */
  meterId: string;
  /** ID real del informe, sin fallback a etiquetas; solo este dato puede salir por email. */
  realMeterId: string;
  window: string;
  label: string;
  percent: number;
}

/** clave «proveedor|medidor|ventana» → ya avisado de que se superó */
export type AlertMemory = Record<string, 'exceeded'>;

const TEN_MIN = 10 * 60_000;

/** Identidad estable del medidor: su id, o la etiqueta en datos antiguos sin id. */
export const meterKey = (m: { id: string; label: string }) => m.id || m.label;

/** Identifica la ventana por su reinicio, redondeado a 10 min (el endpoint lo devuelve con algo de baile). */
export function windowKey(resetsAt: string | null): string {
  const t = resetsAt ? Date.parse(resetsAt) : NaN;
  return Number.isNaN(t) ? 'none' : String(Math.round(t / TEN_MIN));
}

export function detectAlerts(
  prev: UsageReport[],
  next: UsageReport[],
  memory: AlertMemory,
  cfg: Pick<AlertsConfig, 'threshold' | 'onReset'>,
  now: number = Date.now(),
): { events: AlertEvent[]; memory: AlertMemory } {
  const mem: AlertMemory = {};
  // Olvida ventanas que terminaron hace más de 2 días
  for (const [k, v] of Object.entries(memory)) {
    const w = Number(k.split('|').pop());
    if (Number.isNaN(w) || w * TEN_MIN > now - 2 * 86_400_000) mem[k] = v;
  }

  const events: AlertEvent[] = [];
  const prevById = new Map(prev.map((r) => [r.id, r]));

  for (const r of next) {
    // Un informe entero desactualizado no avisa de nada: todo lo que muestra es viejo.
    if (r.stale || (r.status !== 'ok' && r.status !== 'warning')) continue;
    for (const m of r.meters) {
      // Medidor marcado como viejo (conservado del ciclo anterior): sus datos no son
      // de este ciclo, así que no generan ni «superado» ni «reinicio». Los medidores
      // frescos del mismo informe sí avisan con normalidad.
      if (m.stale) continue;
      if (m.percent == null) continue;
      const pct = m.percent;
      const ev = { providerId: r.id, providerName: r.name, meterId: meterKey(m), realMeterId: m.id, window: windowKey(m.resetsAt), label: m.label, percent: pct };

      // 1. Límite superado (una vez por ventana)
      const key = `${r.id}|${meterKey(m)}|${windowKey(m.resetsAt)}`;
      // La memoria guardada antes de existir los ids usaba la etiqueta: no repetir ese aviso.
      const legacyKey = `${r.id}|${m.label}|${windowKey(m.resetsAt)}`;
      if (pct >= cfg.threshold && !mem[key] && !mem[legacyKey]) {
        events.push({ kind: 'exceeded', ...ev });
        mem[key] = 'exceeded';
      }

      // 2. Reinicio de un límite que estaba superado
      if (!cfg.onReset) continue;
      const prevReport = prevById.get(r.id);
      const old = prevReport?.meters.find((x) => meterKey(x) === meterKey(m));
      if (!old || old.percent == null || old.percent < cfg.threshold) continue;
      // La lectura anterior era vieja (no se pudo actualizar en su ciclo): no sabemos
      // cuál era el valor real, así que no se afirma ningún reinicio. Un ciclo degradado
      // seguido de uno sano no puede anunciar un reinicio que nadie vio.
      if (old.stale) continue;
      if (isReset(old, m, pct, cfg.threshold)) events.push({ kind: 'reset', ...ev });
    }
  }
  return { events, memory: mem };
}

/**
 * ¿Cambió la base de medición declarada entre las dos lecturas del mismo medidor? El
 * frente no sabe qué bases usa cada proveedor: compara el dato declarado, sin
 * interpretarlo. Sin base en una de las dos lecturas no hay cambio, así que el medidor se
 * compara como siempre.
 */
function quotaBasisChanged(old: Meter, next: Meter): boolean {
  return !!old.quotaSource && !!next.quotaSource && old.quotaSource !== next.quotaSource;
}

/**
 * ¿Es un reinicio del límite que ya estaba superado? Regla única, compartida por los dos
 * casos: con la misma base de medición se aplica la de siempre; con bases distintas sólo
 * se afirma el reinicio si además la ventana avanzó y el consumo absoluto bajó.
 */
function isReset(old: Meter, next: Meter, pct: number, threshold: number): boolean {
  if (pct >= threshold) return false;
  if (quotaBasisChanged(old, next)) return resetAcrossBasis(old, next);
  const newWindow = old.resetsAt != null && windowKey(old.resetsAt) !== windowKey(next.resetsAt);
  const dropped = (old.percent ?? 0) - pct >= 30;
  return newWindow || dropped;
}

/**
 * Cambio de base de medición: el porcentaje bajó porque cambió el denominador (la cuota
 * que el proveedor declara como base), así que el reinicio sólo se afirma si la ventana
 * nueva arranca DESPUÉS de que terminara la vieja (la renovación) y el consumo absoluto
 * bajó. Las ventanas se comparan POR INSTANTE, no por día: una renovación que cae dentro
 * del mismo día UTC (la ventana vieja termina el 1 a las 00:00 y la nueva arranca el 1 a
 * las 22:15) es una renovación real, y el mismo día no significa el mismo periodo. Lo que
 * se descarta es el solapamiento (la ventana nueva empieza antes de que termine la vieja):
 * ahí las dos fuentes están describiendo periods a la vez y no se puede afirmar nada. Sin
 * unidades comparables o sin los datos de la ventana y del consumo, no se afirma nada.
 */
function resetAcrossBasis(old: Meter, next: Meter): boolean {
  if (old.unit !== next.unit) return false;
  if (old.used == null || next.used == null) return false;
  // Sin la ventana completa en una de las dos lecturas no se afirma nada.
  const oldEnd = windowEnd(old);
  const newStart = windowStart(next);
  if (oldEnd == null || newStart == null || old.windowSeconds == null) return false;
  if (newStart < oldEnd) return false;
  return next.used < old.used;
}

/** El efecto de pantalla se lanza una vez por ciclo: si hay algún límite superado, ese manda. */
export function effectFor(
  events: AlertEvent[],
  cfg: Pick<AlertsConfig, 'exceededEffect' | 'resetEffect'>,
): { effect: Effect; moment: AlertMoment } | null {
  if (events.some((e) => e.kind === 'exceeded')) return { effect: cfg.exceededEffect, moment: 'exceeded' };
  if (events.length) return { effect: cfg.resetEffect, moment: 'reset' };
  return null;
}

/** Texto para la notificación nativa. */
export function notificationText(events: AlertEvent[]): { title: string; body: string } | null {
  if (!events.length) return null;
  const line = (e: AlertEvent) =>
    e.kind === 'reset'
      ? `${e.providerName} · ${e.label}: disponible de nuevo (${Math.round(e.percent)} %)`
      : `${e.providerName} · ${e.label}: ${Math.round(e.percent)} %`;
  const exceeded = events.some((e) => e.kind === 'exceeded');
  return { title: exceeded ? 'Límite superado' : 'Límite reiniciado', body: events.map(line).join('\n') };
}
