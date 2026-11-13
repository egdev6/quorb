import type { ButtonHTMLAttributes, CSSProperties } from 'react';
import type { Locale, Status, UsageReport } from '../lib/types';
import { t } from '../i18n';
import { peakMeter, currentMeters, hasStaleData } from '../lib/format';
import { meterColor } from '../lib/meter-colors';
import { ProviderLogo } from './ProviderLogo';
import { ValidityBadge } from './ValidityBadge';
import { validityInfo } from '../lib/validity';
import { resetCreditsInfo } from '../lib/reset-credits';

/** Estado visual del Gauge (EGDEV Foundation): aviso, agotado o sin datos. */
export function gaugeState(report: UsageReport, threshold = 90): 'over' | 'warning' | 'muted' | null {
  const muted = report.status === 'needsLogin' || report.status === 'unconfigured' || report.status === 'error';
  if (muted) return 'muted';
  // El estado se calcula sobre el pico VIGENTE: lo viejo no se presenta como el
  // estado de ahora. Sin ninguna lectura vigente el orbe queda atenuado, pero sólo
  // si hay algún dato viejo detrás que mostrar: una suscripción inactiva sin
  // ninguna lectura sigue avisando con el tono de aviso (no hay nada viejo que atenuar).
  const peak = peakMeter(report);
  if (!peak && hasStaleData(report)) return 'muted';
  const percent = peak?.percent ?? 0;
  if (percent >= 100) return 'over';
  if (percent >= threshold || report.status === 'warning') return 'warning';
  return null;
}

/** Motivo accesible de los tres estados atenuados (#214): falta credencial, sin configurar o error.
 *  Solo `needsLogin` y `unconfigured` tienen acción asociada (login/settings), y esa pareja muestra badge. */
const STATUS_REASON: Partial<Record<Status, 'details.status.needsLogin' | 'details.status.unconfigured' | 'details.status.error'>> = {
  needsLogin: 'details.status.needsLogin',
  unconfigured: 'details.status.unconfigured',
  error: 'details.status.error',
};

/**
 * Círculo de la tira: Gauge del DS (hasta tres anillos concéntricos + logo), sin texto.
 * Los detalles se ven en el panel que se abre al pasar el ratón.
 */
export function ProviderGauge({
  report,
  small,
  size,
  active,
  account,
  locale = 'es',
  showResets = true,
  threshold,
  dragging = false,
  onHover,
  onPointerEnter,
  onClick,
  pointer,
}: {
  report: UsageReport;
  small: boolean;
  /** Diámetro en px */
  size: number;
  active: boolean;
  /** Número de cuenta cuando el proveedor tiene varias («1», «2»…) */
  account?: string;
  /** Idioma de los títulos accesibles (validez y saldos) */
  locale?: Locale;
  /** Ocultar solo el saldo de resets, no la identidad ni las fechas. */
  showResets?: boolean;
  /** Umbral de aviso (%) */
  threshold?: number;
  onHover: (el: HTMLElement) => void;
  /**
   * Entrada del puntero (#222): solo `mouseenter`. Si no se pasa, la entrada
   * abre como `onHover`; el foco y el clic siguen usando `onHover`.
   */
  onPointerEnter?: (el: HTMLElement) => void;
  /**
   * Clic sobre el orbe (#170): ancla el panel. Si no se pasa, el clic abre el
   * panel como hace el hover.
   */
  onClick?: (el: HTMLElement) => void;
  /** Se está arrastrando para reordenar */
  dragging?: boolean;
  /** Manejadores de puntero para reordenar arrastrando */
  pointer?: Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp'>;
}) {
  const validity = validityInfo(report, locale);
  const resets = showResets ? resetCreditsInfo(report, locale) : null;
  const state = gaugeState(report, threshold);
  // Motivo del estado atenuado (#214): entra al título accesible entre el nombre y la validez.
  const statusReason = STATUS_REASON[report.status];
  const reasonKey = statusReason ?? (state === 'muted' ? 'details.status.noCurrentReading' : undefined);
  const reason = reasonKey ? t(locale, reasonKey) : null;
  const accessibleTitle = [report.name, reason, validity?.title, resets?.title].filter(Boolean).join(' · ');
  const peak = peakMeter(report);
  // Los anillos se dibujan con los medidores VIGENTES: lo viejo no entra en el
  // estado de ahora. La lista es la misma que usan la tarjeta y el detalle, así
  // que el índice de anillo (y su color) no se descuadra entre superficies.
  const all = currentMeters(report).filter((m) => m.percent != null);
  // Pequeños: un único anillo con el límite más cercano. Con círculos muy pequeños, máximo dos.
  const rings = small ? (peak ? [peak] : []) : all.slice(0, size < 40 ? 2 : 3);
  // Claude/Codex share period colors with the card, pace and history.
  // Model-based providers such as NaN retain ring-order colors, including their compact ring.
  const list = rings.length ? rings.map((meter, index) => ({
    percent: meter.percent ?? 0,
    color: meterColor(report, meter, index),
  })) : [{ percent: 0, color: 'var(--ring-1)' }];
  // Grosor y separación de los anillos escalan con el círculo (56 px = 4 px + 2 px, como el DS).
  const w = Math.max(2.5, Math.round(size * (small ? 0.09 : 0.072) * 2) / 2);
  const gap = Math.max(1.5, Math.round(size * 0.036 * 2) / 2);

  const cls = ['orb', 'eg-gauge', state && `is-${state}`, active && 'is-hover'].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={cls}
      data-id={report.id}
      data-dragging={dragging || undefined}
      data-status={report.status}
      data-account={account}
      aria-label={accessibleTitle}
      title={account || reason || validity || resets ? accessibleTitle : undefined}
      aria-expanded={active}
      style={{ '--size': `${size}px`, '--w': `${w}px`, '--gap': `${gap}px` } as CSSProperties}
      onMouseEnter={(e) => (onPointerEnter ?? onHover)(e.currentTarget)}
      onFocus={(e) => {
        // Windows can restore pointer-acquired focus when the popup hides.
        // Treating that as hover reopens it outside both windows, causing a loop.
        // Keep keyboard focus opening, and leave other platforms unchanged.
        if (/Windows/.test(navigator.userAgent) && !e.currentTarget.matches(':focus-visible')) return;
        onHover(e.currentTarget);
      }}
      onClick={(e) => (onClick ?? onHover)(e.currentTarget)}
      onPointerCancel={pointer?.onPointerUp}
      {...pointer}
    >
      {list.map(({ percent, color }, i) => (
        <span key={i} className="eg-gauge__ring" style={{ '--p': Math.max(0, Math.min(100, percent)) / 100, '--c': color } as CSSProperties} />
      ))}
      <span className="eg-gauge__logo logo">
        <ProviderLogo id={report.id} name={report.name} />
      </span>
      <ValidityBadge report={report} compact showResets={showResets} locale={locale} />
      {/* Badge ámbar (#214): solo los estados con acción; decorativo, el motivo legible va en el título. */}
      {/* Sin badge para `error`: la señal queda solo en el texto accesible. */}
      {report.status === 'needsLogin' || report.status === 'unconfigured' ? (
        <span className="orb__badge" data-kind="action" aria-hidden="true" />
      ) : null}
      {account && (
        <span className="orb__acct" aria-hidden="true">
          {account}
        </span>
      )}
    </button>
  );
}
