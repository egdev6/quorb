import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { formatCompact, formatMoney, formatResetIn, shortLabel } from '../lib/format';
import { meterPace, spendPace, type Pace } from '../lib/pace';
import type { Locale, Sample, UsageReport } from '../lib/types';
import { intlLocale, t } from '../i18n';
import { RING_COLORS } from './RingGauge';
import { disclosureOpen, popupMeterColor, saveDisclosure } from '../lib/popup-preferences';

const RANGES = [
  { hours: 24, key: 'details.range24h' },
  { hours: 24 * 7, key: 'details.range7d' },
  { hours: 24 * 30, key: 'details.range30d' },
] as const;

function untilText(d: Date, locale: Locale): string {
  return formatResetIn(d.toISOString(), new Date(), locale) ?? '';
}

function paceText(p: Pace, locale: Locale): string {
  if (p.ratio == null) return t(locale, 'details.windowJustStarted');
  const r = p.ratio.toLocaleString(intlLocale(locale), { maximumFractionDigits: 1 });
  if (p.status === 'over' && p.exhaustAt) return t(locale, 'details.paceBurnsOut', { pace: r, when: untilText(p.exhaustAt, locale) });
  if (p.status === 'over') return t(locale, 'details.paceWontLast', { pace: r });
  return t(locale, 'details.paceProjected', { pace: r, pct: Math.round(p.projected ?? 0) });
}

/** Barra de ritmo: relleno = consumido; marca vertical = tiempo transcurrido. */
function PaceBar({ pace, color, locale }: { pace: Pace; color: string; locale: Locale }) {
  return (
    <span className="pace__track" data-status={pace.status}>
      <span className="pace__fill" style={{ width: `${Math.min(100, pace.used * 100)}%`, background: color }} />
      <span className="pace__now" style={{ left: `${pace.elapsed * 100}%` }} title={t(locale, 'details.elapsedTitle')} />
    </span>
  );
}

function Sparkline({ series, max, height = 46, locale }: { series: { color: string; points: [number, number][] }[]; max: number; height?: number; locale: Locale }) {
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) return <p className="hist__empty">{t(locale, 'details.notEnoughReadings')}</p>;
  const t0 = Math.min(...all.map((p) => p[0]));
  const t1 = Math.max(...all.map((p) => p[0]));
  const W = 100;
  const x = (t: number) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * W);
  const y = (v: number) => height - 2 - (Math.min(v, max) / max) * (height - 4);
  return (
    <svg className="hist__svg" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img" aria-label={t(locale, 'details.historyAria')}>
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
function DailyBars({ days, locale }: { days: { date: string; value: number }[]; locale: Locale }) {
  const last = days.slice(-30);
  const max = Math.max(...last.map((d) => d.value), 1);
  const H = 40;
  const bw = 100 / last.length;
  const fmtDay = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(intlLocale(locale), { day: 'numeric', month: 'short' });
  return (
    <div className="daily">
      <svg className="hist__svg" viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" role="img" aria-label={t(locale, 'details.dailyAria')}>
        {last.map((d, i) => {
          const h = Math.max(0.6, (d.value / max) * (H - 2));
          return (
            <rect key={d.date} x={i * bw + bw * 0.15} y={H - h} width={bw * 0.7} height={h} rx="0.6" fill="var(--ring-1)">
              <title>{t(locale, 'details.dailyBarTitle', { day: fmtDay(d.date), value: formatCompact(d.value) })}</title>
            </rect>
          );
        })}
      </svg>
      <span className="daily__axis">
        <span>{fmtDay(last[0].date)}</span>
        <span>{t(locale, 'details.dailyMax', { value: formatCompact(max) })}</span>
        <span>{fmtDay(last[last.length - 1].date)}</span>
      </span>
    </div>
  );
}

export function ProviderDetails({ report, locale = 'es' }: { report: UsageReport; locale?: Locale }) {
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
  const paces = ringMeters.map((m, i) => ({ m, color: popupMeterColor(report, m, i), pace: meterPace(m) }));
  const sp = report.spend ? spendPace(report.spend) : null;

  const series = useMemo(() => {
    if (!samples) return { pct: [], spend: [] as [number, number][] };
    // History includes every percentage quota, not just the gauge's visible rings.
    const pct = ringMeters.map((m, i) => ({
      color: popupMeterColor(report, m, i),
      points: samples.filter((s) => s.l === m.id || s.l === m.label).map((s) => [s.t, s.v] as [number, number]),
    }));
    const spend = samples.filter((s) => s.l === 'spend').map((s) => [s.t, s.v] as [number, number]);
    return { pct, spend };
  }, [samples, report.meters, report.id, report.kind]);

  // Escala del eje: no aplastamos consumos pequeños contra el 0.
  const peakPct = Math.max(0, ...series.pct.flatMap((s) => s.points.map((p) => p[1])));
  const pctMax = Math.min(100, Math.max(10, Math.ceil((peakPct * 1.15) / 5) * 5));
  const spendMax = Math.max(report.spend?.budget ?? 0, ...series.spend.map((p) => p[1]), 1);
  const activeRange = RANGES.find((r) => r.hours === hours);

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
            <b>{t(locale, 'details.atThisPace')}</b>{' '}
            {t(locale, 'details.paceNotice', {
              label: shortLabel(risk.m.label, risk.m.id, locale),
              when: risk.pace.exhaustAt ? ` ${untilText(risk.pace.exhaustAt, locale)}` : '',
            })}
          </span>
        </div>
      )}
      <details className="details__sec" open={paceOpen} onToggle={(e) => {
        const open = e.currentTarget.open;
        setPaceOpen(open);
        saveDisclosure(report.id, 'pace', open);
      }}>
        <summary className="details__toggle"><h3 className="details__title">{t(locale, 'details.paceTitle')}</h3></summary>
        <div className="details__body">
          {paces.filter((p) => p.pace).length === 0 && !sp && <p className="hist__empty">{t(locale, 'details.noWindow')}</p>}
          {paces.map(
            ({ m, color, pace }) =>
              pace && (
                <div key={m.id || m.label} className="pace" data-status={pace.status}>
                  <span className="pace__row">
                    <span className="pace__label">{shortLabel(m.label, m.id, locale)}</span>
                    <span className="pace__txt">{paceText(pace, locale)}</span>
                  </span>
                  <PaceBar pace={pace} color={color} locale={locale} />
                </div>
              ),
          )}
          {sp && report.spend && (
            <div className="pace" data-status={sp.status}>
              <span className="pace__row">
                <span className="pace__label">{t(locale, 'details.spendLabel')}</span>
                <span className="pace__txt">
                  {sp.projectedAmount != null
                    ? t(locale, 'details.monthProjection', { amount: formatMoney(sp.projectedAmount, report.spend.currency) })
                    : t(locale, 'details.monthJustStarted')}
                </span>
              </span>
              {report.spend.budget ? <PaceBar pace={sp} color={RING_COLORS[0]} locale={locale} /> : null}
            </div>
          )}
        </div>
      </details>

      <details className="details__sec" open={historyOpen} onToggle={(e) => {
        const open = e.currentTarget.open;
        setHistoryOpen(open);
        saveDisclosure(report.id, 'history', open);
      }}>
        <summary className="details__toggle"><h3 className="details__title">{t(locale, 'details.historyTitle')}</h3></summary>
        <div className="details__body">
          <div className="details__head">
            <div className="eg-tabs eg-tabs--segmented eg-tabs--sm" role="tablist" aria-label={t(locale, 'details.historyRangeAria')}>
              {RANGES.map((r) => (
                <button key={r.hours} type="button" role="tab" className="eg-tabs__item" aria-selected={hours === r.hours} onClick={() => setHours(r.hours)}>
                  {t(locale, r.key)}
                </button>
              ))}
            </div>
          </div>
          {samples == null ? (
            <p className="hist__empty">{t(locale, 'details.loading')}</p>
          ) : series.pct.some((s) => s.points.length) ? (
            <>
              <div className="q-well">
                <Sparkline series={series.pct} max={pctMax} locale={locale} />
              </div>
              <span className="daily__axis">
                <span>{activeRange ? t(locale, activeRange.key) : ''}</span>
                <span>{t(locale, 'details.scaleTo', { max: pctMax })}</span>
              </span>
            </>
          ) : series.spend.length ? (
            <div className="q-well">
              <Sparkline series={[{ color: RING_COLORS[0], points: series.spend }]} max={spendMax} locale={locale} />
            </div>
          ) : (
            <p className="hist__empty">{t(locale, 'details.noReadings')}</p>
          )}
          {report.daily && report.daily.length > 1 && (
            <section className="details__daily">
              <h4 className="details__title">{t(locale, 'details.dailyTitle')}</h4>
              <DailyBars days={report.daily} locale={locale} />
            </section>
          )}
        </div>
      </details>
    </div>
  );
}
