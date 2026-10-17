import { useState } from 'react';
import type { UsageReport } from '../lib/types';
import { formatMoney } from '../lib/format';
import { MeterBar } from './MeterBar';
import { api } from '../lib/api';
import { ProviderLogo } from './ProviderLogo';
import { ValidityBadge } from './ValidityBadge';

const STATUS: Record<UsageReport['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  ok: { label: 'Al día', tone: 'success' },
  warning: { label: 'Atención', tone: 'warning' },
  error: { label: 'Error', tone: 'danger' },
  needsLogin: { label: 'Sin sesión', tone: 'danger' },
  unconfigured: { label: 'Sin configurar', tone: 'neutral' },
};

function ActionButton({ report }: { report: UsageReport }) {
  // Si no se puede abrir el login (p. ej. falta el CLI), se explica aquí mismo.
  const [error, setError] = useState<string | null>(null);
  if (report.action === 'login') {
    return (
      <>
        <button
          className="eg-btn eg-btn--primary eg-btn--sm"
          title={report.stale ? 'Abre el CLI oficial, que renueva la sesión; el widget se actualiza solo al terminar' : undefined}
          onClick={() => {
            setError(null);
            api.openLogin(report.id).catch((e) => setError(String(e)));
          }}
        >
          {report.stale ? 'Renovar sesión' : 'Iniciar sesión'}
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
        Configurar
      </button>
    );
  }
  return null;
}

/** Cabecera y límites del panel de detalle (ModuleCard --glass del DS). */
export function ProviderCard({ report }: { report: UsageReport }) {
  const { spend } = report;
  const status = STATUS[report.status];
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
          report.status !== 'ok' && <span className={`eg-status eg-status--${status.tone}`}>{status.label}</span>
        )}
        {report.stale && (
          <span className="eg-status eg-status--neutral" title="Datos del último ciclo correcto">
            caché
          </span>
        )}
      </div>

      {report.meters.length > 0 && (
        <div className="q-card__meters">
          {report.meters.map((m) => {
            // Mismo color que su anillo en el círculo.
            const r = m.percent != null && ring < 3 ? ++ring : null;
            return <MeterBar key={m.label} meter={m} ring={r} />;
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
              <span className="eg-stat__label">Presupuesto</span>
              <span className="eg-stat__value">{formatMoney(spend.budget, spend.currency)}</span>
            </div>
          )}
        </div>
      )}

      <ValidityBadge report={report} />

      {report.message && (
        <div className={`eg-notice eg-notice--sm eg-notice--${report.status === 'ok' ? 'info' : status.tone === 'neutral' ? 'info' : status.tone}`} role="status">
          <span className="eg-notice__text">{report.message}</span>
        </div>
      )}
      <ActionButton report={report} />
    </div>
  );
}
