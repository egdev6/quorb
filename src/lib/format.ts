import type { Locale, Meter, UsageReport } from './types';
import { t, intlLocale, type MessageKey } from '../i18n';
import { meterKey } from './alerts';
import { windowEnd } from './window';

/** «en 2 h 13 min», «en 3 d 4 h», «ahora» */
export function formatResetIn(iso: string | null, now: Date = new Date(), locale: Locale = 'es'): string | null {
  if (!iso) return null;
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return null;
  const mins = Math.round((target - now.getTime()) / 60000);
  if (mins <= 0) return t(locale, 'details.resetIn.now');
  if (mins < 60) return t(locale, 'details.resetIn.minutes', { mins });
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? t(locale, 'details.resetIn.hoursMinutes', { h, m }) : t(locale, 'details.resetIn.hours', { h });
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? t(locale, 'details.resetIn.daysHours', { d, h: rh }) : t(locale, 'details.resetIn.days', { d });
}

export function formatMoney(amount: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** 3_000_000_000 → «3 B», 400_000_000 → «400 M», 1500 → «1,5 K» */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  const fmt = (v: number) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(v);
  if (abs >= 1e9) return `${fmt(n / 1e9)} B`;
  if (abs >= 1e6) return `${fmt(n / 1e6)} M`;
  if (abs >= 1e3) return `${fmt(n / 1e3)} K`;
  return fmt(n);
}

export function formatPercent(p: number): string {
  return `${Math.round(p)}%`;
}

/**
 * La hora de la última lectura: la hora local de quien mira, como el resto de la app
 * («actualizado» en el detalle). El instante es UTC; lo que se muestra es local.
 */
export function formatReadTime(iso: string | null, locale: Locale = 'es'): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(intlLocale(locale), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/**
 * La marca de lo viejo: el texto de la pastilla («caché») y, cuando se sabe, la hora
 * de la última lectura. El TEXTO es uno solo (barra y resumen); el gatillo difiere:
 * la barra marca el medidor marcado individualmente, el resumen también los del
 * informe entero (`isStaleMeter`).
 */
export function staleMark(readAt: string | null, locale: Locale = 'es'): string {
  const chip = t(locale, 'details.staleChip');
  const time = formatReadTime(readAt, locale);
  return time ? `${chip} · ${t(locale, 'details.staleReadAtTime', { time })}` : chip;
}

// Etiqueta corta para la leyenda de los anillos: por id estable, con la etiqueta
// larga como respaldo para datos antiguos sin id.
const KEY_BY_ID = new Map<string, MessageKey>([
  ['weekly', 'details.meters.weekly'],
  ['weekly_opus', 'details.meters.weeklyOpus'],
  ['weekly_sonnet', 'details.meters.weeklySonnet'],
  ['weekly_apps', 'details.meters.weeklyApps'],
  ['budget_monthly', 'details.meters.budgetMonthly'],
  ['rate_requests', 'details.meters.rateRequests'],
  ['rate_tokens', 'details.meters.rateTokens'],
  ['extra_usage', 'details.meters.extraUsage'],
]);

const KEY_BY_LABEL = new Map<string, MessageKey>([
  ['Semana · todos', 'details.meters.weekly'],
  ['Semana · Opus', 'details.meters.weeklyOpus'],
  ['Semana · Sonnet', 'details.meters.weeklySonnet'],
  ['Semana · apps', 'details.meters.weeklyApps'],
  ['Presupuesto mensual', 'details.meters.budgetMonthly'],
  ['Peticiones (ventana)', 'details.meters.rateRequests'],
  ['Tokens (ventana)', 'details.meters.rateTokens'],
  ['Uso extra (mes)', 'details.meters.extraUsage'],
]);

/** Etiqueta corta para la leyenda de los anillos: por id estable, con la etiqueta como respaldo. */
export function shortLabel(label: string, id = '', locale: Locale = 'es'): string {
  const key = KEY_BY_ID.get(id) ?? KEY_BY_LABEL.get(label);
  return key ? t(locale, key) : label.replace(/^Sesión · /, 'Sesión ');
}

export type Level = 'low' | 'mid' | 'high' | 'max';
export function levelFor(p: number | null): Level {
  if (p == null) return 'low';
  if (p >= 90) return 'max';
  if (p >= 70) return 'high';
  if (p >= 40) return 'mid';
  return 'low';
}

/**
 * ¿Este medidor es viejo? Lo obsoleto se declara por dos vías: el propio medidor
 * (`Meter.stale`, cuando el ciclo fallido no lo trajo) o el informe entero que lo
 * contiene (`UsageReport.stale`, cuando no quedó ningún medidor fresco). Las dos
 * reglas viven aquí; ningún consumidor las copia.
 */
export function isStaleMeter(report: UsageReport, meter: Meter): boolean {
  return meter.stale === true || report.stale === true;
}

/** Los medidores vigentes del informe: los que sí describen el estado de ahora. */
export function currentMeters(report: UsageReport): Meter[] {
  return report.meters.filter((m) => !isStaleMeter(report, m));
}

/**
 * ¿El gasto del informe es viejo? Lo es cuando el INFORME ENTERO lo es: un informe
 * conservado trae el importe del ciclo anterior. Un informe con un medidor viejo y
 * gasto fresco (el informe mixto) sí trae el gasto de este ciclo: ese gasto se ve.
 *
 * La regla es del informe, no de los medidores: un medidor viejo no vuelve viejo el
 * gasto, y un informe viejo no deja al gasto como si fuera de ahora.
 */
export function isStaleSpend(report: UsageReport): boolean {
  return report.stale === true;
}

/** ¿El informe muestra algún dato viejo? (Un medidor marcado o el informe entero.) */
export function hasStaleData(report: UsageReport): boolean {
  return report.stale === true || report.meters.some((m) => m.stale === true);
}

/** Medidor con el porcentaje más alto (lo que antes te va a bloquear). */
export function peakMeter(r: UsageReport): Meter | null {
  let best: Meter | null = null;
  for (const m of currentMeters(r)) {
    if (m.percent == null) continue;
    if (!best || (best.percent ?? 0) < m.percent) best = m;
  }
  return best;
}

/**
 * ¿El régimen que declara el informe nuevo impide conservar los medidores del anterior?
 *
 * El texto del régimen es opaco: el frente no sabe qué significa, sólo si es el mismo.
 * La comparación es SIMÉTRICA: «no declarar» no es una declaración, en ninguno de los
 * dos lados. Sólo se bloquea cuando LOS DOS informes declaran régimen y son distintos:
 * - los dos declaran y difieren → los medidores del anterior son de un régimen que ya
 *   no aplica y no se conservan;
 * - sólo uno declara (o ninguno) → no hay comparación posible: no se bloquea nada y los
 *   datos anteriores se conservan como estaban, marcados como desactualizados (como
 *   siempre: el último ciclo correcto no se borra).
 */
function regimeBlocksKeeping(old: UsageReport | undefined, next: UsageReport): boolean {
  const before = old?.billingRegime;
  const after = next.billingRegime;
  // Sin declaración en los dos lados no hay comparación posible: no se bloquea nada.
  if (before == null || after == null) return false;
  return before !== after;
}

/**
 * Si un ciclo falla pero el anterior tenía datos, conservamos los datos
 * antiguos marcados como `stale` para que el widget no se quede vacío.
 *
 * `now` se inyecta para que la regla de vencimiento sea determinista: un medidor
 * conservado cuyo periodo ya terminó no se conserva (su lectura es del periodo
 * anterior, y presentarla como vigente sería mentir). La regla vale para las TRES
 * ramas que conservan datos del ciclo anterior (T45): la mixta, la de informe entero
 * y la de sesión caducada.
 */
export function mergeReports(prev: UsageReport[], next: UsageReport[], now: number = Date.now()): UsageReport[] {
  const byId = new Map(prev.map((r) => [r.id, r]));
  return next.map((r) => {
    const old = byId.get(r.id);
    const failed = r.status === 'error' || r.status === 'warning';
    if (failed && r.meters.length === 0 && !r.spend && old && (old.meters.length > 0 || old.spend)) {
      // Si los dos informes declaran un régimen DISTINTO, los medidores del informe
      // anterior (topes por modelo de una cuenta que ya no se factura así) no se
      // pueden atribuir al régimen vigente, así que no se resucitan. Si alguno no
      // declara régimen no hay comparación y se conserva lo anterior, como siempre.
      // El plan no es una lectura —nombra la cuenta— y sí se conserva.
      if (regimeBlocksKeeping(old, r)) return { ...r, plan: r.plan ?? old.plan };
      // Los medidores cuyo periodo ya terminó no se conservan (T45, el mismo criterio
      // que M3 aplica al camino mixto): su lectura es del periodo anterior y se
      // presentaría como vigente («Se reinicia ahora»).
      const alive = old.meters.filter((m) => !windowEnded(m, now));
      // Sin nada vigente que conservar no hay nada viejo que mostrar: el informe
      // fallido se queda tal cual (mismo criterio que el camino mixto).
      if (alive.length === 0 && !old.spend) return { ...r, plan: r.plan ?? old.plan };
      return { ...old, status: 'warning', message: r.message, stale: true, meters: stamped(alive, old.fetchedAt) };
    }
    // Un ciclo fallido puede llegar MIXTO: la cuota de la cuenta falló, pero las cabeceras
    // de rate limit vinieron. Los medidores que el informe nuevo NO trae se conservan del
    // anterior, marcados UNO POR UNO como desactualizados, para que los datos de cuota no
    // desaparezcan en silencio. El informe mergeado manda; lo que no trae se conserva del
    // anterior. El informe NO queda desactualizado entero: trae datos frescos, y marcarlo
    // saltaría los avisos del ciclo entero (con el fresco incluido).
    // Si los dos informes declaran un régimen DISTINTO, la regla de no resucitar
    // medidores de otro régimen se aplica aquí (mismo sitio, misma marca): los medidores
    // que el informe nuevo no trae no se conservan (arriba, con `regimeBlocksKeeping`).
    // Si alguno de los dos no declara régimen no hay comparación y se conserva lo anterior.
    if (failed && r.meters.length > 0 && old && (old.meters.length > 0 || old.spend)) {
      // Con un régimen declarado por el informe nuevo tampoco se conservan los medidores
      // que el informe nuevo no trae: no se pueden atribuir al régimen vigente (mismo
      // sitio, misma marca).
      if (regimeBlocksKeeping(old, r)) return { ...r, plan: r.plan ?? old.plan };
      // Lo que el informe nuevo no trae se conserva del anterior… salvo que su periodo
      // ya haya terminado: entonces la lectura es del periodo anterior y no se
      // conserva (si no, se vería como vigente, con «Se reinicia ahora»).
      const missing = old.meters.filter((om) => !r.meters.some((nm) => meterKey(om) === meterKey(nm)) && !windowEnded(om, now));
      // Si no se conserva ningún medidor, no hay nada viejo que avisar: el informe
      // nuevo se queda tal cual (sus medidores son todos frescos).
      if (!missing.length) return r;
      // Se conservan SÓLO los medidores: la serie diaria y el gasto son lecturas
      // también, y arrastrarlas mostraría datos viejos sin marcar (la base no lo
      // hacía). Si este ciclo no los trae, no se muestran. El plan no es una
      // lectura —nombra la cuenta— y sí se conserva.
      return {
        ...r,
        meters: [...r.meters, ...missing.map((m) => ({ ...m, stale: true, readAt: m.readAt ?? old.fetchedAt }))],
        plan: r.plan ?? old.plan,
      };
    }
    // Sesión caducada: se conservan los últimos datos (atenuados) con la acción
    // de renovar, en vez de dejar el círculo vacío hasta volver a entrar.
    if (r.status === 'needsLogin' && r.meters.length === 0 && old && old.meters.length > 0) {
      // Mismo criterio de vencimiento (T45): un medidor de un periodo ya terminado no
      // se conserva, para que no salga como vigente con «Se reinicia ahora».
      const alive = old.meters.filter((m) => !windowEnded(m, now));
      // El gasto no tiene ventana: el vencimiento no lo alcanza, así que se conserva
      // como en la rama de error/aviso (si no queda ningún medidor vigente, el informe
      // viejo se conserva con su gasto, marcado).
      if (alive.length === 0 && !old.spend) return { ...r, plan: r.plan ?? old.plan };
      return { ...old, status: 'needsLogin', message: r.message, action: r.action, stale: true, meters: stamped(alive, old.fetchedAt) };
    }
    return r;
  });
}

/**
 * ¿La ventana de este medidor ya terminó? Sin `resetsAt` legible no hay ventana:
 * no se puede saber que el periodo pasó, así que el medidor no se descarta.
 */
function windowEnded(m: Meter, now: number): boolean {
  const end = windowEnd(m);
  return end != null && end < now;
}

/** Estampa en cada medidor conservado la fecha de la lectura de la que viene. */
function stamped(meters: Meter[], readAt: string): Meter[] {
  return meters.map((m) => (m.readAt ? m : { ...m, readAt }));
}

/** Informes que acaban de perder la sesión (antes tenían datos o estaban bien). */
export function sessionsLost(prev: UsageReport[], next: UsageReport[]): UsageReport[] {
  const before = new Map(prev.map((r) => [r.id, r.status]));
  return next.filter((r) => {
    const was = before.get(r.id);
    return r.status === 'needsLogin' && was != null && was !== 'needsLogin' && was !== 'unconfigured';
  });
}

export function trayTooltip(reports: UsageReport[]): string {
  const parts = reports.map((r) => {
    const peak = peakMeter(r);
    if (peak?.percent != null) return `${r.name}: ${formatPercent(peak.percent)}`;
    // Sin pico vigente no se presenta el dato viejo como el estado de ahora; el
    // gasto tampoco, si lo que se ve es el de un ciclo conservado (informe entero
    // viejo). Un informe mixto trae el gasto de este ciclo: ese se ve.
    if (r.spend && !isStaleSpend(r)) return `${r.name}: ${formatMoney(r.spend.amount, r.spend.currency)}`;
    return `${r.name}: —`;
  });
  // Windows limita el tooltip de la bandeja a ~127 caracteres
  return (parts.join('\n') || 'Quorb').slice(0, 127);
}

/** Resumen en texto plano para copiar al portapapeles. */
export function reportSummary(r: UsageReport, now: Date = new Date(), locale: Locale = 'es'): string {
  const lines = [r.plan ? `${r.name} (${r.plan})` : r.name];
  for (const m of r.meters) {
    const reset = formatResetIn(m.resetsAt, now, locale);
    // Lo viejo va marcado: un número viejo no puede salir junto a los frescos con
    // apariencia de actual. La fecha es la de la lectura del medidor; si el informe
    // entero es el conservado (y el medidor no trae la suya), la del informe es la
    // de su última lectura.
    const mark = isStaleMeter(r, m) ? staleMark(m.readAt ?? (r.stale ? r.fetchedAt : null), locale) : null;
    const value =
      m.percent != null
        ? `${Math.round(m.percent)} %`
        : m.used != null
          ? `${formatCompact(m.used)}${m.unit ? ` ${m.unit}` : ''}`
          : '—';
    lines.push(`· ${m.label}: ${value}${reset ? ` (${t(locale, 'details.summaryReset', { when: reset })})` : ''}${mark ? ` · ${mark}` : ''}`);
  }
  // El gasto conservado (informe entero viejo) se ve, pero marcado como viejo: no
  // es una cifra de ahora y su fecha es la de la lectura de la que viene.
  if (r.spend) {
    const mark = isStaleSpend(r) ? staleMark(r.fetchedAt, locale) : null;
    lines.push(`· ${r.spend.periodLabel}: ${formatMoney(r.spend.amount, r.spend.currency)}${mark ? ` · ${mark}` : ''}`);
  }
  if (r.message && r.status !== 'ok') lines.push(`· ${r.message}`);
  return lines.join('\n');
}
