// Corte i18n de T2c slice 1 (#66): las secciones del detalle migradas a los
// catálogos, renderizadas en servidor con el fixture mínimo (sin lecturas ni
// ventanas) para cubrir estados vacíos y títulos en es y en.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderDetails } from './ProviderDetails';
import type { UsageReport } from '../lib/types';

const report: UsageReport = {
  id: 'claude:extra', name: 'Claude · Trabajo', kind: 'subscription', status: 'ok', plan: null,
  meters: [], spend: null, message: null, action: null, fetchedAt: '2026-10-17T00:00:00Z',
  daily: [{ date: '2026-10-15', value: 10 }, { date: '2026-10-16', value: 20 }],
};

const render = (locale: 'es' | 'en') => renderToStaticMarkup(<ProviderDetails report={report} locale={locale} />);

describe('ProviderDetails meter short label (T2c-S1)', () => {
  const withMeter: UsageReport = {
    ...report,
    meters: [{ id: 'weekly', label: 'Semana · todos', percent: 40, used: null, limit: null, unit: null, resetsAt: '2026-10-06T10:45:00Z', windowSeconds: 604800 }],
  };
  const renderMeter = (locale: 'es' | 'en') => renderToStaticMarkup(<ProviderDetails report={withMeter} locale={locale} />);

  it('shortens known meter labels per locale', () => {
    // La fila de ritmo es la única vía pública que imprime la etiqueta corta:
    // con ventana semanal (604800 s) meterPace devuelve un ritmo y la fila se pinta.
    expect(renderMeter('en')).toContain('Week');
    expect(renderMeter('es')).toContain('Semana');
  });
});

describe('ProviderDetails i18n (SSR)', () => {
  it('renders the Spanish labels verbatim from the current literals for es', () => {
    const html = render('es');
    for (const label of [
      'Ritmo de consumo',
      'Sin ventana de tiempo conocida para calcular el ritmo.',
      'Historial',
      'Rango del historial',
      'Cargando…',
      '24 h',
      '7 días',
      '30 días',
      'Tokens por día · 30 días',
    ]) {
      expect(html, `falta «${label}» en es`).toContain(label);
    }
    expect(html).not.toContain('Consumption pace');
    expect(html).not.toContain('Loading');
  });

  it('renders the English labels when the locale is en', () => {
    const html = render('en');
    for (const label of [
      'Consumption pace',
      'No known time window to calculate the pace.',
      'History',
      'History range',
      'Loading…',
      '24 h',
      '7 days',
      '30 days',
      'Tokens per day · 30 days',
    ]) {
      expect(html, `falta «${label}» en en`).toContain(label);
    }
    expect(html).not.toContain('Ritmo de consumo');
    expect(html).not.toContain('Cargando');
  });

  it('keeps the days unit translated only in the range labels, not in dates', () => {
    // El eje de DailyBars formatea fechas reales: el nombre del mes no es un literal del catálogo.
    const html = render('en');
    expect(html).toContain('7 days');
    expect(html).not.toContain('7 días');
  });
});
