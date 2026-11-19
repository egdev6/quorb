import type { CSSProperties } from 'react';
import type { Locale, Meter } from '../lib/types';
import { formatCompact, formatPercent, formatResetIn, levelFor, staleMark } from '../lib/format';
import { t } from '../i18n';

/**
 * Un límite del panel (EGDEV Foundation): marca del anillo + etiqueta + %,
 * ProgressBar --lg y cuándo se reinicia. `ring` = anillo del círculo (1–3) o null.
 * `color` conserva la identidad del límite, incluso cuando no cabe en el círculo.
 * Un medidor viejo se marca y se atenúa entero (por clase del tema).
 *
 * `stale` es el veredicto de obsolescencia, lo calcula `isStaleMeter` (el medidor lo
 * marca o lo marca el informe entero que lo contiene). Quien lo pinte se lo pasa: la
 * barra no copia la regla. Sin ese contexto sólo veía la marca individual, y un
 * informe entero viejo salía sin marcar en la barra (T46).
 */
export function MeterBar({ meter, ring, color, locale = 'es', stale: staleVerdict }: { meter: Meter; ring: number | null; color?: string; locale?: Locale; stale?: boolean }) {
  const pct = meter.percent;
  // La marca de lo viejo: el veredicto que le pasa quien la pinta; si no viene, la
  // marca individual del medidor.
  const stale = staleVerdict ?? meter.stale === true;
  const reset = formatResetIn(meter.resetsAt, new Date(), locale);
  const amount =
    meter.used != null
      ? meter.limit != null
        ? `${formatCompact(meter.used)} / ${formatCompact(meter.limit)}${meter.unit ? ` ${meter.unit}` : ''}`
        : `${formatCompact(meter.used)}${meter.unit ? ` ${meter.unit}` : ''}`
      : null;
  const meta = [pct != null ? amount : null, reset ? t(locale, 'details.meterResets', { when: reset }) : null].filter(Boolean).join(' · ');

  return (
    <div
      className={`q-meter${stale ? ' q-meter--stale' : ''}`}
      data-ring={ring ?? undefined}
      data-level={levelFor(pct)}
      data-stale={stale ? 'true' : undefined}
      data-colored={color ? true : undefined}
      style={color ? { '--meter-color': color } as CSSProperties : undefined}
    >
      <div className="q-meter__row">
        {(ring != null || color) && (
          <span
            className={`eg-gauge__key${ring != null && ring > 1 ? ` eg-gauge__key--${ring}` : ''}`}
            aria-hidden="true"
          />
        )}
        <span className="q-meter__label">{meter.label}</span>
        <b className="q-meter__value">{pct != null ? formatPercent(pct) : amount}</b>
      </div>
      {pct != null && (
        <span
          className="eg-progress eg-progress--lg"
          role="progressbar"
          aria-label={meter.label}
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{ '--p': Math.min(100, Math.max(0, pct)) / 100 } as CSSProperties}
        >
          <span className="eg-progress__bar" />
        </span>
      )}
      {meta && <span className="q-meter__meta">{meta}</span>}
      {stale && (
        <span className="q-meter__meta" title={t(locale, 'details.staleChipTitle')}>
          {staleMark(meter.readAt ?? null, locale)}
        </span>
      )}
    </div>
  );
}
