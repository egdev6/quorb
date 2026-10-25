// Corte i18n de T2c slice 1 (#66): el fallback de la tira cuando no hay orbs
// visibles (error / cargando / sin configurar), extraído a componente puro con
// locale para poder renderizarlo en servidor en ambos idiomas.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StripFallback } from './StripFallback';

const props = (locale: 'es' | 'en') => ({
  locale,
  error: null as string | null,
  busy: false,
  ready: true,
  onRetry: () => {},
  onConfigure: () => {},
});

describe('StripFallback i18n (SSR)', () => {
  it('renders the Spanish fallbacks verbatim for es', () => {
    expect(renderToStaticMarkup(<StripFallback {...props('es')} error="sin red" />), 'error → Reintentar').toContain('Reintentar');
    expect(renderToStaticMarkup(<StripFallback {...props('es')} busy />), 'busy → Cargando…').toContain('Cargando…');
    expect(renderToStaticMarkup(<StripFallback {...props('es')} />), 'ready → Configurar').toContain('Configurar');
    expect(renderToStaticMarkup(<StripFallback {...props('es')} error="sin red" />)).not.toContain('Retry');
  });

  it('renders the English fallbacks when the locale is en', () => {
    expect(renderToStaticMarkup(<StripFallback {...props('en')} error="no network" />), 'error → Retry').toContain('Retry');
    expect(renderToStaticMarkup(<StripFallback {...props('en')} busy />), 'busy → Loading…').toContain('Loading…');
    expect(renderToStaticMarkup(<StripFallback {...props('en')} />), 'ready → Configure').toContain('Configure');
    expect(renderToStaticMarkup(<StripFallback {...props('en')} busy />)).not.toContain('Cargando');
  });

  it('shows the retry title with the raw error text in both locales', () => {
    for (const locale of ['es', 'en'] as const) {
      const html = renderToStaticMarkup(<StripFallback {...props(locale)} error="sin red" />);
      expect(html).toContain('title="sin red"');
    }
  });
});
