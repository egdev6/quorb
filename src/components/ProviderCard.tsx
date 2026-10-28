import { useState } from 'react';
import type { Locale, UsageReport } from '../lib/types';
import { formatMoney } from '../lib/format';
import { t } from '../i18n';
import { MeterBar } from './MeterBar';
import { popupMeterColor } from '../lib/popup-preferences';
import { api } from '../lib/api';
import { ProviderLogo } from './ProviderLogo';
import { ValidityBadge } from './ValidityBadge';

// El tono es identidad visual; el texto del estado sale del catálogo por locale.
const STATUS_TONE: Record<UsageReport['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  ok: 'success',
  warning: 'warning',
  error: 'danger',
  needsLogin: 'danger',
  unconfigured: 'neutral',
};

function ActionButton({ report, locale = 'es' }: { report: UsageReport; locale?: Locale }) {
  // Si no se puede abrir el login (p. ej. falta el CLI), se explica aquí mismo.
  const [error, setError] = useState<string | null>(null);
  if (report.action === 'login') {
    return (
      <>
        <button
          className="eg-btn eg-btn--primary eg-btn--sm"
          title={report.stale ? t(locale, 'details.action.renewHint') : undefined}
          onClick={() => {
            setError(null);
            api.openLogin(report.id).catch((e) => setError(String(e)));
          }}
        >
          {report.stale ? t(locale, 'details.action.renew') : t(locale, 'details.action.login')}
        </button>
        {error && (
          <div className="eg-notice eg-notice--sm eg-notice--warning" role="alert">
            <span className="eg-notice__text">{error}</span>
          </div>
        )}
      </>
    );
  }
  if (report.action === 'settings') {
    return (
      <button className="eg-btn eg-btn--secondary eg-btn--sm" onClick={() => api.openSettings().catch(console.error)}>
        {t(locale, 'details.action.configure')}
      </button>
    );
  }
  return null;
}

/** Cabecera y límites del panel de detalle (ModuleCard --glass del DS). */
export function ProviderCard({ report, locale = 'es' }: { report: UsageReport; locale?: Locale }) {
  const { spend } = report;
  const tone = STATUS_TONE[report.status];
  let ring = 0;
  return (
    <div className="q-card" data-status={report.status} data-provider={report.id}>
      <div className="eg-module-card__head">
        <span className="q-card__logo logo">
          <ProviderLogo id={report.id} name={report.name} />
        </span>
        <h2 className="eg-module-card__name">{report.name}</h2>
        {report.plan ? (
          <span className="eg-status eg-status--neutral">{report.plan}</span>
        ) : (
          report.status !== 'ok' && <span className={`eg-status eg-status--${tone}`}>{t(locale, `details.status.${report.status}`)}</span>
        )}
        {report.stale && (
          <span className="eg-status eg-status--neutral" title={t(locale, 'details.staleChipTitle')}>
            {t(locale, 'details.staleChip')}
          </span>
        )}
      </div>

      {report.meters.length > 0 && (
        <div className="q-card__meters">
          {report.meters.map((m) => {
            // Count only percentage quotas, just like the gauge and detail series.
            const index = m.percent != null ? ring++ : null;
            const r = index != null && index < 3 ? index + 1 : null;
            return (
              <MeterBar
                key={m.id || m.label}
                meter={m}
                ring={r}
                color={index != null ? popupMeterColor(report, m, index) : undefined}
                locale={locale}
              />
            );
          })}
        </div>
      )}

      {spend && (
        <div className="q-card__stats">
          <div className="eg-stat eg-stat--sm">
            <span className="eg-stat__label">{spend.periodLabel}</span>
            <span className="eg-stat__value">{formatMoney(spend.amount, spend.currency)}</span>
          </div>
          {spend.budget != null && spend.budget > 0 && (
            <div className="eg-stat eg-stat--sm">
              <span className="eg-stat__label">{t(locale, 'details.budget')}</span>
              <span className="eg-stat__value">{formatMoney(spend.budget, spend.currency)}</span>
            </div>
          )}
        </div>
      )}

      <ValidityBadge report={report} locale={locale} />

      {report.message && (
        <div className={`eg-notice eg-notice--sm eg-notice--${report.status === 'ok' ? 'info' : tone === 'neutral' ? 'info' : tone}`} role="status">
          <span className="eg-notice__text">{report.message}</span>
        </div>
      )}
      <ActionButton report={report} locale={locale} />
    </div>
  );
}
