// Fallback de la tira cuando no hay orbs visibles (T2c slice 1, #66):
// error de arranque, carga o primera ejecución sin configurar. Extraído de
// Widget.tsx como componente puro con `locale` para probarlo en servidor.
import { t } from '../i18n';
import type { Locale } from '../lib/types';

export function StripFallback({ error, busy, ready, locale, onRetry, onConfigure }: {
  error: string | null;
  busy: boolean;
  ready: boolean;
  locale: Locale;
  onRetry: () => void;
  onConfigure: () => void;
}) {
  if (error) {
    return (
      <button className="btn btn--accent btn--sm" onClick={onRetry} title={error}>
        {t(locale, 'widget.retry')}
      </button>
    );
  }
  if (busy || !ready) {
    return <span style={{ color: 'var(--text-2)', fontSize: 11, padding: '0 6px' }}>{t(locale, 'widget.loading')}</span>;
  }
  return (
    <button className="btn btn--accent btn--sm" onClick={onConfigure}>
      {t(locale, 'widget.configure')}
    </button>
  );
}
