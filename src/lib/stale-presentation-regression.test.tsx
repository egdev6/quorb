import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mergeReports, peakMeter, reportSummary, trayTooltip } from './format';
import { detectAlerts } from './alerts';
import { ProviderCard } from '../components/ProviderCard';
import type { UsageReport } from './types';

const rep = (o: Partial<UsageReport> = {}): UsageReport => ({
  id: 'claude',
  name: 'Claude',
  kind: 'subscription',
  status: 'ok',
  plan: 'Max',
  meters: [
    {
      id: 'weekly',
      label: 'Semana · todos',
      percent: 81,
      used: null,
      limit: null,
      unit: null,
      resetsAt: '2026-11-15T00:00:00Z',
      windowSeconds: 604800,
    },
  ],
  spend: null,
  message: null,
  action: null,
  fetchedAt: '2026-11-12T08:00:00Z',
  ...o,
});

describe('S33/S34/T35 — el dato obsoleto no es el estado actual', () => {
  it('sin dato viejo nada cambia: pico, tooltip, salud y resumen son los del ciclo', () => {
    const r = rep();
    expect(peakMeter(r)?.percent).toBe(81);
    expect(trayTooltip([r])).toBe('Claude: 81%');
    expect(reportSummary(r, new Date('2026-11-12T10:00:00Z'))).toContain('Semana · todos: 81 %');
  });

  it('informe entero conservado: el viejo no da pico ni tooltip, pero se ve con su fecha', () => {
    // El instante se fija: el ciclo falló con la ventana del medidor TODAVÍA abierta
    // (termina el 15-11), así que el informe entero se conserva y queda viejo. Con la
    // ventana ya pasada el medidor caduca y no se conserva (T45), que es otro
    // escenario con su propio test.
    const [m] = mergeReports(
      [rep()],
      [rep({ status: 'warning', meters: [], message: 'error de red' })],
      Date.parse('2026-11-12T10:00:00Z'),
    );
    expect(m.stale).toBe(true);
    expect(peakMeter(m)).toBeNull();
    expect(trayTooltip([m])).toBe('Claude: —');
    const html = renderToStaticMarkup(<ProviderCard report={m} locale="es" />);
    expect(html).toContain('caché'); // pastilla del informe entero
    expect(html).not.toContain('data-ring="1"'); // no ocupa anillo
    // La fecha de su última lectura va en el resumen que se copia (la marca es un
    // solo texto: «caché · leído a las HH:MM»).
    expect(reportSummary(m, new Date('2026-11-12T10:00:00Z'))).toContain('leído a las');
  });

  it('medidor viejo conservado (informe mixto): se marca y se atenúa en la barra', () => {
    // El medidor marcado uno por uno es el que la barra marca y atenúa: la pintura
    // de (c) va por clase del tema, no por estilo en línea.
    const viejo = { ...rep().meters[0], stale: true, readAt: '2026-11-11T08:00:00Z' };
    const html = renderToStaticMarkup(<ProviderCard report={rep({ status: 'warning', meters: [viejo] })} locale="es" />);
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('q-meter--stale');
    expect(html).toContain('caché');
  });

  it('un medidor viejo no avisa (ni «superado» ni «reinicio»)', () => {
    const viejo = { ...rep().meters[0], stale: true, readAt: '2026-11-11T08:00:00Z' };
    const next = [rep({ status: 'warning', meters: [viejo] })];
    expect(
      detectAlerts(
        [rep()],
        next,
        {},
        { threshold: 90, onReset: true },
        Date.parse('2026-11-12T10:00:00Z'),
      ).events,
    ).toEqual([]);
  });

  it('cambio de base de medición: no hay reinicio falso, y el reinicio real del mismo día UTC sí se avisa', () => {
    const cfg = { threshold: 90, onReset: true };
    const now = Date.parse('2026-11-12T10:00:00Z');
    const cuota = (quotaSource: string, over: object = {}) => ({
      id: 'model:glm5.3-flash',
      label: 'glm5.3-flash',
      percent: 95.558,
      used: 955581032,
      limit: 1000000000,
      unit: 'tokens',
      resetsAt: '2026-12-05T22:15:31Z',
      windowSeconds: 2592000,
      quotaSource,
      ...over,
    });
    const prev = [rep({ id: 'nan', name: 'NaN Builders', meters: [cuota('account')] })];
    const falso = [
      rep({
        id: 'nan',
        name: 'NaN Builders',
        status: 'warning',
        meters: [cuota('published', { percent: 31.853, limit: 3000000000 })],
      }),
    ];
    // Mismo consumo, otra base: no es un reinicio (S17).
    expect(detectAlerts(prev, falso, {}, cfg, now).events).toEqual([]);
    // Y el reinicio REAL dentro del mismo día UTC sí se avisa (no es lo mismo que el
    // falso): el periodo publicado termina el 1-dic a las 00:00 y el de la cuenta
    // empieza ese mismo día a las 22:15:31, así que las dos ventanas caen el mismo
    // día calendario pero no se solapan, y el consumo bajó (950 M → 60 M).
    const antes = [
      rep({
        id: 'nan',
        name: 'NaN Builders',
        meters: [cuota('published', { percent: 95, used: 950_000_000, limit: 1_000_000_000, resetsAt: '2026-12-01T00:00:00Z' })],
      }),
    ];
    const real = [
      rep({
        id: 'nan',
        name: 'NaN Builders',
        meters: [cuota('account', { percent: 2, used: 60_000_000, limit: 3_000_000_000, resetsAt: '2026-12-31T22:15:31Z' })],
      }),
    ];
    expect(detectAlerts(antes, real, {}, cfg, now).events.map((e) => e.kind)).toEqual(['reset']);
  });
});
