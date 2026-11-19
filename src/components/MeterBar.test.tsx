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
  // La hora de la última lectura se muestra en la hora local de quien mira: el
  // `readAt` se arma con la hora local para que el test no dependa de la zona de la
  // máquina (el instante sigue siendo UTC).
  const localReadAt = new Date(2026, 10, 10, 8, 30).toISOString();
  const stale: Meter = { ...fresh, id: 'model:deepseek-v4-flash', label: 'deepseek-v4-flash', percent: 95.558, used: 955_581_032, limit: 1_000_000_000, unit: 'tokens', stale: true, readAt: localReadAt };

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
    // es la local de quien mira, como el «actualizado» del detalle.
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

// T46: el gatillo de la marca es UNO solo (`isStaleMeter`): un medidor es viejo si él
// lo marca o si lo marca el informe entero que lo contiene. La barra recibía sólo la
// marca individual, así que un informe entero viejo salía marcado en el resumen
// copiable y SIN marca en la barra. Quien la pinte le pasa el veredicto.
describe('MeterBar y el informe entero viejo (T46)', () => {
  const meter: Meter = {
    id: 'weekly',
    label: 'Semana · todos',
    percent: 50,
    used: null,
    limit: null,
    unit: null,
    resetsAt: null,
    windowSeconds: null,
  };

  it('marks a meter of a stale report even if the meter itself is not marked', () => {
    const html = renderToStaticMarkup(<MeterBar meter={meter} ring={null} locale="es" stale />);
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('caché');
    // La atenuación es la misma que la de un medidor marcado individualmente.
    expect(html).toContain('q-meter--stale');
  });

  it('does not mark a meter of a fresh report', () => {
    const html = renderToStaticMarkup(<MeterBar meter={meter} ring={null} locale="es" stale={false} />);
    expect(html).not.toContain('data-stale');
    expect(html).not.toContain('caché');
  });

  it('does not let a false verdict hide a marked meter', () => {
    // La marca individual no se puede ocultar: aunque quien la pinta pase un veredicto
    // en falso, un medidor marcado sigue marcado (el gatillo es `isStaleMeter`, que
    // ya incluye la marca individual y la del informe entero).
    const marked: Meter = { ...meter, stale: true, readAt: new Date(2026, 10, 10, 8, 30).toISOString() };
    const html = renderToStaticMarkup(<MeterBar meter={marked} ring={null} locale="es" stale={false} />);
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('q-meter--stale');
  });
});

// La base de la cuota se muestra en el medidor cuando NO es la de la cuenta: el número
// no viene de la lectura de la cuenta, así que no puede presentarse como su estado.
describe('MeterBar y la base de la cuota (T48)', () => {
  const meter: Meter = {
    id: 'model:deepseek-v4-flash',
    label: 'deepseek-v4-flash',
    percent: 95.558,
    used: 955_581_032,
    limit: 1_000_000_000,
    unit: 'tokens',
    resetsAt: null,
    windowSeconds: null,
  };

  it('notes a meter that was not measured against the account quota', () => {
    const published: Meter = { ...meter, quotaSource: 'published' };
    const html = renderToStaticMarkup(<MeterBar meter={published} ring={null} locale="es" />);
    expect(html).toContain('publicada');
    // El tooltip explica qué significa: no es la cuota de la cuenta.
    expect(html).toContain('No se pudo leer la cuota de tu cuenta');
  });

  it('does not note a meter measured against the account quota', () => {
    // El caso normal no se anota: una etiqueta en cada barra sería ruido.
    const account: Meter = { ...meter, quotaSource: 'account' };
    const html = renderToStaticMarkup(<MeterBar meter={account} ring={null} locale="es" />);
    expect(html).not.toContain('publicada');
  });

  it('says it in English too', () => {
    const published: Meter = { ...meter, quotaSource: 'published' };
    const html = renderToStaticMarkup(<MeterBar meter={published} ring={null} locale="en" />);
    expect(html).toContain('published');
    expect(html).toContain('quota could not be read');
  });
});

