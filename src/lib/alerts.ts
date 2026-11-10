// Avisos en dos momentos:
//   1. «exceeded»: un límite pasa del umbral configurado (por defecto 90 %).
//   2. «reset»: ese límite, que se había superado, se reinicia (nueva ventana o baja de golpe).
// Se recuerda qué se ha avisado por ventana para no repetir (la memoria se guarda en el widget).

import type { AlertMoment, AlertsConfig, Effect, UsageReport } from './types';

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
  label: string;
  percent: number;
}

/** clave «proveedor|medidor|ventana» → ya avisado de que se superó */
export type AlertMemory = Record<string, 'exceeded'>;

const TEN_MIN = 10 * 60_000;

/** Identidad estable del medidor: su id, o la etiqueta en datos antiguos sin id. */
const meterKey = (m: { id: string; label: string }) => m.id || m.label;

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
    if (r.stale || (r.status !== 'ok' && r.status !== 'warning')) continue;
    for (const m of r.meters) {
      if (m.percent == null) continue;
      const pct = m.percent;
      const ev = { providerId: r.id, providerName: r.name, label: m.label, percent: pct };

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
      // Un cambio de la fuente de la cuota no es un reinicio: el porcentaje bajó porque
      // cambió el denominador (la regla que se aplica), no porque la cuota se reiniciara.
      if (quotaSourceChanged(prevReport, r)) continue;
      const newWindow = old.resetsAt != null && windowKey(old.resetsAt) !== windowKey(m.resetsAt);
      const dropped = old.percent - pct >= 30;
      if (pct < cfg.threshold && (newWindow || dropped)) events.push({ kind: 'reset', ...ev });
    }
  }
  return { events, memory: mem };
}

/**
 * ¿Cambió la fuente de la cuota entre las dos lecturas? El frente no sabe de qué
 * proveedor viene el informe: compara el dato de la fuente, no valores concretos.
 */
function quotaSourceChanged(prev: UsageReport | undefined, next: UsageReport): boolean {
  return !!prev?.quotaSource && !!next.quotaSource && prev.quotaSource !== next.quotaSource;
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
