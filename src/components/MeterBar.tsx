import type { CSSProperties } from 'react';
import type { Locale, Meter } from '../lib/types';
import { declaredLabel, formatAmount, formatPercent, formatResetIn, levelFor, quotaBasisNote, staleMark, unitLabel } from '../lib/format';
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
export function MeterBar({
  meter,
  ring,
  color,
  locale = 'es',
  stale: staleVerdict,
}: {
  meter: Meter;
  ring: number | null;
  color?: string;
  locale?: Locale;
  stale?: boolean;
}) {
  const pct = meter.percent;
  // La marca no se puede ocultar: aunque el veredicto venga en falso, un medidor
  // marcado individualmente sigue marcado. El gatillo es `isStaleMeter`, que ya
  // incluye la marca individual y la del informe entero.
  const stale = staleVerdict === true || meter.stale === true;
  // La base de la cuota, cuando el medidor no se midió contra la cuota de la cuenta:
  // el número no viene de la lectura de la cuenta, así que se dice.
  const basis = quotaBasisNote(meter.quotaSource, locale);
  const reset = formatResetIn(meter.resetsAt, new Date(), locale);
  // La unidad la declara el backend y la traduce el catálogo (si la conoce).
  const unit = unitLabel(meter.unit, locale);
  const amount =
    meter.used != null
      ? meter.limit != null
        ? `${formatAmount(meter.used, meter.unit, locale)} / ${formatAmount(meter.limit, meter.unit, locale)}${unit ? ` ${unit}` : ''}`
        : `${formatAmount(meter.used, meter.unit, locale)}${unit ? ` ${unit}` : ''}`
      : null;
  // El consumo que pasa del tope: el importe muestra el exceso (S13, «más del 100 %»).
  const excess =
    pct != null && meter.used != null && meter.limit != null && meter.used > meter.limit
      ? t(locale, 'details.meterExcess', {
          amount: `${formatAmount(meter.used - meter.limit, meter.unit, locale)}${unit ? ` ${unit}` : ''}`,
        })
      : null;
  const meta = [pct != null ? amount : null, excess, reset ? t(locale, 'details.meterResets', { when: reset }) : null].filter(Boolean).join(' · ');

  return (
    <div
      className={`q-meter${stale ? ' q-meter--stale' : ''}`}
      data-ring={ring ?? undefined}
      data-level={levelFor(pct)}
      data-stale={stale ? 'true' : undefined}
      data-colored={color ? true : undefined}
      style={color ? ({ '--meter-color': color } as CSSProperties) : undefined}
    >
      <div className="q-meter__row">
        {(ring != null || color) && <span className={`eg-gauge__key${ring != null && ring > 1 ? ` eg-gauge__key--${ring}` : ''}`} aria-hidden="true" />}
        <span className="q-meter__label">
          {declaredLabel(meter, locale)}
          {basis && (
            <span className="eg-status eg-status--neutral q-meter__basis" title={basis.title}>
              {basis.label}
            </span>
          )}
        </span>
        <b className="q-meter__value">{pct != null ? formatPercent(pct) : amount}</b>
      </div>
      {pct != null && (
        <span
          className="eg-progress eg-progress--lg"
          role="progressbar"
          aria-label={declaredLabel(meter, locale)}
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
