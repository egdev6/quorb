import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MeterBar } from './MeterBar';
import type { Meter } from '../lib/types';

// B2 (S50): la marca mínima de lo viejo en pantalla. Un medidor viejo necesita una
// marca: `data-stale` y una línea con el texto de la pastilla y la hora de su última
// lectura. La presentación completa (atenuación, serie, pastilla del informe) es de (c).
describe('MeterBar marca lo viejo (B2)', () => {
  const fresh: Meter = {
    id: 'weekly',
    label: 'Semana · todos',
    percent: 50,
    used: null,
    limit: null,
    unit: null,
    resetsAt: null,
    windowSeconds: null,
  };
  const stale: Meter = { ...fresh, id: 'model:deepseek-v4-flash', label: 'deepseek-v4-flash', percent: 95.558, used: 955_581_032, limit: 1_000_000_000, unit: 'tokens', stale: true, readAt: '2026-11-10T08:30:00Z' };

  it('renders a fresh meter exactly as before', () => {
    // Un medidor fresco no cambia ni un byte: la marca sólo aparece con lo viejo.
    expect(renderToStaticMarkup(<MeterBar meter={fresh} ring={null} locale="es" />)).toBe(
      '<div class="q-meter" data-level="mid"><div class="q-meter__row"><span class="q-meter__label">Semana · todos</span><b class="q-meter__value">50%</b></div><span class="eg-progress eg-progress--lg" role="progressbar" aria-label="Semana · todos" aria-valuenow="50" aria-valuemin="0" aria-valuemax="100" style="--p:0.5"><span class="eg-progress__bar"></span></span></div>',
    );
  });

  it('marks a stale meter with data-stale and the time of its last reading', () => {
    const html = renderToStaticMarkup(<MeterBar meter={stale} ring={null} locale="es" />);
    expect(html).toContain('data-stale="true"');
    // El texto de la pastilla se reutiliza («caché») y la hora de la última lectura
    // se en UTC, para que no dependa de la zona de quien mira.
    expect(html).toContain('caché');
    expect(html).toContain('leído a las 08:30');
  });

  it('says the same in English', () => {
    const html = renderToStaticMarkup(<MeterBar meter={stale} ring={null} locale="en" />);
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('cached');
    expect(html).toContain('read at 08:30');
  });
});

