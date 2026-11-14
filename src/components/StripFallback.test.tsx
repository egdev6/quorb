// Corte i18n de T2c slice 1 (#66): el fallback de la tira cuando no hay orbs
// visibles (error / cargando / sin configurar), extraído a componente puro con
// locale para poder renderizarlo en servidor en ambos idiomas.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StripFallback } from './StripFallback';

const props = (locale: 'es' | 'en') => ({
  locale,
  state: 'ready' as const,
  error: null as string | null,
  busy: false,
  onRetry: () => {},
  onConfigure: () => {},
});

describe('StripFallback i18n (SSR)', () => {
  it('renders the Spanish fallbacks verbatim for es', () => {
    expect(renderToStaticMarkup(<StripFallback {...props('es')} state="failed" error="sin red" />), 'failed → Reintentar').toContain('Reintentar');
    expect(renderToStaticMarkup(<StripFallback {...props('es')} busy />), 'busy → Cargando…').toContain('Cargando…');
    expect(renderToStaticMarkup(<StripFallback {...props('es')} />), 'ready → Configurar').toContain('Configurar');
    expect(renderToStaticMarkup(<StripFallback {...props('es')} state="failed" error="sin red" />)).not.toContain('Retry');
  });

  it('renders the English fallbacks when the locale is en', () => {
    expect(renderToStaticMarkup(<StripFallback {...props('en')} state="failed" error="no network" />), 'failed → Retry').toContain('Retry');
    expect(renderToStaticMarkup(<StripFallback {...props('en')} busy />), 'busy → Loading…').toContain('Loading…');
    expect(renderToStaticMarkup(<StripFallback {...props('en')} />), 'ready → Configure').toContain('Configure');
    expect(renderToStaticMarkup(<StripFallback {...props('en')} busy />)).not.toContain('Cargando');
  });

  it('shows the retry title with the raw error text in both locales', () => {
    for (const locale of ['es', 'en'] as const) {
      const html = renderToStaticMarkup(<StripFallback {...props(locale)} state="failed" error="sin red" />);
      expect(html).toContain('title="sin red"');
    }
  });

  // Precisión 1 (#271): mientras la config está pendiente, el neutro gana
  // incluso si hay un error ajeno (refresco/arrastre); solo `failed` muestra
  // el fallback explícito.
  it('pending is neutral: no localized text, even with an unrelated error', () => {
    for (const locale of ['es', 'en'] as const) {
      const html = renderToStaticMarkup(<StripFallback {...props(locale)} state="pending" error="boom" />);
      expect(html, `pending neutral: ${locale}`).not.toContain('Cargando');
      expect(html, `pending neutral: ${locale}`).not.toContain('Loading');
      expect(html, `pending neutral: ${locale}`).not.toContain('Reintentar');
      expect(html, `pending neutral: ${locale}`).not.toContain('Retry');
      expect(html, `pending neutral: ${locale}`).not.toContain('Configurar');
      expect(html, `pending neutral: ${locale}`).not.toContain('Configure');
      expect(html).toContain('strip__pending');
    }
  });

  it('failed is explicit even with an unrelated busy state', () => {
    const html = renderToStaticMarkup(<StripFallback {...props('en')} state="failed" error="config unreachable" busy />);
    expect(html).toContain('Retry');
    expect(html).toContain('title="config unreachable"');
  });
});
