// Fallback de la tira cuando no hay orbs visibles (T2c slice 1, #66):
// carga de la configuración pendiente, fallo definitivo de configuración o
// primera ejecución sin configurar. Extraído de Widget.tsx como componente
// puro con `locale` para probarlo en servidor.
//
// Estado explícito del ARRANQUE de la configuración (revisión PR #271): el
// `error` genérico de `Widget` (fallos de refresco, arrastre…) NO decide el
// fallback. `state` distingue:
// - `pending`: la config aún no llegó y no hay fallo definitivo → estado
//   NEUTRO sin textos localizados (nadie ve «Cargando…» en el idioma
//   equivocado antes de conocer el idioma guardado).
// - `failed`: los reintentos de `getConfig` se agotaron → fallback explícito
//   (`widget.retry`) con el locale por defecto; `error` es el texto crudo del
//   fallo de config, no un error ajeno.
// - `ready`: la config está disponible → «Cargando…» en el idioma correcto
//   mientras `busy`, o «Configurar» cuando no hay orbs.
import { t } from '../i18n';
import type { Locale } from '../lib/types';

export type StripFallbackState = 'pending' | 'ready' | 'failed';

export function StripFallback({ state, error, busy, locale, onRetry, onConfigure }: {
  /** Estado del arranque de la configuración (#271). */
  state: StripFallbackState;
  /** Texto crudo del fallo definitivo de config (solo se usa en `failed`). */
  error: string | null;
  /** Refresco en curso (solo `ready`: la config ya está, el idioma es seguro). */
  busy: boolean;
  locale: Locale;
  onRetry: () => void;
  onConfigure: () => void;
}) {
  if (state === 'pending') {
    // Neutro y sin texto: hasta que llegue la config no sabemos el idioma
    // guardado, así que la primera muestra no puede emitir cadenas localizadas.
    return <span className="strip__pending" aria-hidden="true" />;
  }
  if (state === 'failed') {
    return (
      <button className="btn btn--accent btn--sm" onClick={onRetry} title={error ?? undefined}>
        {t(locale, 'widget.retry')}
      </button>
    );
  }
  if (busy) {
    return <span style={{ color: 'var(--text-2)', fontSize: 11, padding: '0 6px' }}>{t(locale, 'widget.loading')}</span>;
  }
  return (
    <button className="btn btn--accent btn--sm" onClick={onConfigure}>
      {t(locale, 'widget.configure')}
    </button>
  );
}