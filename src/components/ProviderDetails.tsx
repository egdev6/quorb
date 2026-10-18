import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { formatCompact, formatMoney, formatResetIn, shortLabel } from '../lib/format';
import { meterPace, spendPace, type Pace } from '../lib/pace';
import type { Sample, UsageReport } from '../lib/types';
import { meterColor } from '../lib/meter-colors';
import { RING_COLORS } from './RingGauge';
import { disclosureOpen, saveDisclosure } from '../lib/popup-preferences';

const RANGES = [
  { hours: 24, label: '24 h' },
  { hours: 24 * 7, label: '7 días' },
  { hours: 24 * 30, label: '30 días' },
] as const;

function untilText(d: Date): string {
  return formatResetIn(d.toISOString()) ?? '';
}

function paceText(p: Pace): string {
  if (p.ratio == null) return 'Acaba de empezar la ventana';
  const r = p.ratio.toLocaleString('es-ES', { maximumFractionDigits: 1 });
  if (p.status === 'over' && p.exhaustAt) return `Ritmo ${r}× · se agota ${untilText(p.exhaustAt)}`;
  if (p.status === 'over') return `Ritmo ${r}× · no llegas al reinicio`;
  if (p.status === 'fast') return `Ritmo ${r}× · acabarías en ${Math.round(p.projected ?? 0)} %`;
  return `Ritmo ${r}× · acabarías en ${Math.round(p.projected ?? 0)} %`;
}

/** Barra de ritmo: relleno = consumido; marca vertical = tiempo transcurrido. */
function PaceBar({ pace, color }: { pace: Pace; color: string }) {
  return (
    <span className="pace__track" data-status={pace.status}>
      <span className="pace__fill" style={{ width: `${Math.min(100, pace.used * 100)}%`, background: color }} />
      <span className="pace__now" style={{ left: `${pace.elapsed * 100}%` }} title="Tiempo transcurrido de la ventana" />
    </span>
  );
}

function Sparkline({ series, max, height = 46 }: { series: { color: string; points: [number, number][] }[]; max: number; height?: number }) {
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) return <p className="hist__empty">Aún no hay suficientes lecturas. Se irán guardando cada pocos minutos.</p>;
  const t0 = Math.min(...all.map((p) => p[0]));
  const t1 = Math.max(...all.map((p) => p[0]));
  const W = 100;
  const x = (t: number) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * W);
  const y = (v: number) => height - 2 - (Math.min(v, max) / max) * (height - 4);
  return (
    <svg className="hist__svg" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img" aria-label="Historial de consumo">
      {[0.5, 1].map((g) => (
        <line key={g} x1="0" x2={W} y1={y(max * g)} y2={y(max * g)} className="hist__grid" />
      ))}
      {series.map((s, i) => (
        <polyline
          key={i}
          fill="none"
          stroke={s.color}
          strokeWidth="1.6"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          points={s.points.map(([t, v]) => `${x(t).toFixed(2)},${y(v).toFixed(2)}`).join(' ')}
        />
      ))}
    </svg>
  );
}

/** Barras de tokens por día (datos del propio proveedor, p. ej. NaN). */
function DailyBars({ days }: { days: { date: string; value: number }[] }) {
  const last = days.slice(-30);
  const max = Math.max(...last.map((d) => d.value), 1);
  const H = 40;
  const bw = 100 / last.length;
  const fmtDay = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  return (
    <div className="daily">
      <svg className="hist__svg" viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" role="img" aria-label="Tokens por día">
        {last.map((d, i) => {
          const h = Math.max(0.6, (d.value / max) * (H - 2));
          return (
            <rect key={d.date} x={i * bw + bw * 0.15} y={H - h} width={bw * 0.7} height={h} rx="0.6" fill="var(--ring-1)">
              <title>{`${fmtDay(d.date)}: ${formatCompact(d.value)} tokens`}</title>
            </rect>
          );
        })}
      </svg>
      <span className="daily__axis">
        <span>{fmtDay(last[0].date)}</span>
        <span>máx. {formatCompact(max)}</span>
        <span>{fmtDay(last[last.length - 1].date)}</span>
      </span>
    </div>
  );
}

export function ProviderDetails({ report }: { report: UsageReport }) {
  const [paceOpen, setPaceOpen] = useState(() => disclosureOpen(report.id, 'pace'));
  const [historyOpen, setHistoryOpen] = useState(() => disclosureOpen(report.id, 'history'));
  const [hours, setHours] = useState<number>(24 * 7);
  const [samples, setSamples] = useState<Sample[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getHistory(report.id, hours)
      .then((s) => alive && setSamples(s))
      .catch(() => alive && setSamples([]));
    return () => {
      alive = false;
    };
  }, [report.id, hours, report.fetchedAt]);

  const ringMeters = report.meters.filter((m) => m.percent != null);
  const paces = ringMeters.map((m, i) => ({ m, color: meterColor(report, m, i), pace: meterPace(m) }));
  const sp = report.spend ? spendPace(report.spend) : null;

  const series = useMemo(() => {
    if (!samples) return { pct: [], spend: [] as [number, number][] };
    // History includes every percentage quota, not just the gauge's visible rings.
    const pct = ringMeters.map((m, i) => ({
      color: meterColor(report, m, i),
      points: samples.filter((s) => s.l === m.label).map((s) => [s.t, s.v] as [number, number]),
    }));
    const spend = samples.filter((s) => s.l === 'spend').map((s) => [s.t, s.v] as [number, number]);
    return { pct, spend };
  }, [samples, report.meters, report.id]);

  // Escala del eje: no aplastamos consumos pequeños contra el 0.
  const peakPct = Math.max(0, ...series.pct.flatMap((s) => s.points.map((p) => p[1])));
  const pctMax = Math.min(100, Math.max(10, Math.ceil((peakPct * 1.15) / 5) * 5));
  const spendMax = Math.max(report.spend?.budget ?? 0, ...series.spend.map((p) => p[1]), 1);

  // Aviso destacado (Notice --sm del DS) cuando a este ritmo un límite se agota antes de reiniciarse.
  const risk = paces.find((p) => p.pace?.status === 'over');

  return (
    <div className="details">
      {risk?.pace && (
        <div className="eg-notice eg-notice--warning eg-notice--sm" role="status">
          <svg className="eg-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
          <span className="eg-notice__text">
            <b>A este ritmo</b> {shortLabel(risk.m.label)} se agota{risk.pace.exhaustAt ? ` ${untilText(risk.pace.exhaustAt)}` : ''}, antes del reinicio.
          </span>
        </div>
      )}
      <details className="details__sec" open={paceOpen} onToggle={(e) => {
        const open = e.currentTarget.open;
        setPaceOpen(open);
        saveDisclosure(report.id, 'pace', open);
      }}>
        <summary className="details__toggle"><h3 className="details__title">Ritmo de consumo</h3></summary>
        <div className="details__body">
          {paces.filter((p) => p.pace).length === 0 && !sp && <p className="hist__empty">Sin ventana de tiempo conocida para calcular el ritmo.</p>}
          {paces.map(
            ({ m, color, pace }) =>
              pace && (
                <div key={m.label} className="pace" data-status={pace.status}>
                  <span className="pace__row">
                    <span className="pace__label">{shortLabel(m.label)}</span>
                    <span className="pace__txt">{paceText(pace)}</span>
                  </span>
                  <PaceBar pace={pace} color={color} />
                </div>
              ),
          )}
          {sp && report.spend && (
            <div className="pace" data-status={sp.status}>
              <span className="pace__row">
                <span className="pace__label">Gasto</span>
                <span className="pace__txt">
                  {sp.projectedAmount != null
                    ? `Al ritmo actual: ${formatMoney(sp.projectedAmount, report.spend.currency)} a fin de mes`
                    : 'Acaba de empezar el mes'}
                </span>
              </span>
              {report.spend.budget ? <PaceBar pace={sp} color={RING_COLORS[0]} /> : null}
            </div>
          )}
        </div>
      </details>

      <details className="details__sec" open={historyOpen} onToggle={(e) => {
        const open = e.currentTarget.open;
        setHistoryOpen(open);
        saveDisclosure(report.id, 'history', open);
      }}>
        <summary className="details__toggle"><h3 className="details__title">Historial</h3></summary>
        <div className="details__body">
          <div className="details__head">
            <div className="eg-tabs eg-tabs--segmented eg-tabs--sm" role="tablist" aria-label="Rango del historial">
              {RANGES.map((r) => (
                <button key={r.hours} type="button" role="tab" className="eg-tabs__item" aria-selected={hours === r.hours} onClick={() => setHours(r.hours)}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          {samples == null ? (
            <p className="hist__empty">Cargando…</p>
          ) : series.pct.some((s) => s.points.length) ? (
            <>
              <div className="q-well">
                <Sparkline series={series.pct} max={pctMax} />
              </div>
              <span className="daily__axis">
                <span>{RANGES.find((r) => r.hours === hours)?.label}</span>
                <span>escala 0–{pctMax} %</span>
              </span>
            </>
          ) : series.spend.length ? (
            <div className="q-well">
              <Sparkline series={[{ color: RING_COLORS[0], points: series.spend }]} max={spendMax} />
            </div>
          ) : (
            <p className="hist__empty">Aún no hay lecturas guardadas.</p>
          )}
          {report.daily && report.daily.length > 1 && (
            <section className="details__daily">
              <h4 className="details__title">Tokens por día · 30 días</h4>
              <DailyBars days={report.daily} />
            </section>
          )}
        </div>
      </details>
    </div>
  );
}
