// Prueba de renderizado real en servidor (renderToStaticMarkup), sin DOM falso,
// como el resto del repositorio: sin estado el panel no pinta nada. Los efectos
// (listener de estado y cola de colocación) no corren en SSR, así que la
// disciplina de la caché del panel se fija aquí sobre las mismas primitivas que
// el efecto y el listener usan literalmente — `confirmDetailPlacement` y
// `samePlacement` en la condición de salida temprana (#215).

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DetailPanel } from './DetailPanel';
import { confirmDetailPlacement, type DetailPlacementReport } from './detail-placement';
import type { PhysicalBounds } from './lib/detail-panel';
import { samePlacement } from './lib/widget-placement';

describe('DetailPanel (SSR)', () => {
  it('renders nothing until the widget sends state', () => {
    // Los efectos no corren en el servidor: sin estado no hay marcado.
    expect(renderToStaticMarkup(<DetailPanel />)).toBe('');
  });
});

/**
 * Las refs `lastAppliedRef` + `lastAppliedReadBackRef` + `positionedRef` tal
 * como el efecto de layout las cablea: se vacían antes de cada aplicación,
 * `confirmDetailPlacement` sólo cachea geometría confirmada, y `wouldDedupe`
 * es la condición literal de salida temprana del efecto
 * (`positionedRef && samePlacement(...)`).
 */
const wireUp = () => {
  const cache = { bounds: null as PhysicalBounds | null, readBack: false };
  const positioned = { current: false };
  const cacheConfirmed = (bounds: PhysicalBounds) => { cache.bounds = bounds; cache.readBack = true; };
  const apply = (report: DetailPlacementReport): boolean =>
    confirmDetailPlacement(report, cacheConfirmed);
  const resetForClose = () => {
    // Reset del listener de estado cuando el widget cierra el panel (o al
    // cerrarse de nuevo): `lastAppliedRef` vacío + `positioned` false.
    positioned.current = false;
    cache.bounds = null;
    cache.readBack = false;
  };
  const wouldDedupe = (requested: PhysicalBounds): boolean =>
    positioned.current && samePlacement(cache.bounds, requested, cache.readBack);
  const report = (over: Partial<DetailPlacementReport> = {}): DetailPlacementReport => ({
    status: 'applied',
    bounds: null,
    read_back: true,
    ...over,
  });
  return { cache, positioned, cacheConfirmed, apply, resetForClose, wouldDedupe, report };
};

describe('caché de lastApplied (#215)', () => {
  const initial: PhysicalBounds = { x: 120, y: 900, w: 330, h: 379 };

  it('sólo la geometría confirmada (read-back) deduplica un re-pedido idéntico', () => {
    const { positioned, apply, wouldDedupe, report } = wireUp();
    expect(apply(report({ bounds: initial }))).toBe(false);
    positioned.current = true;
    expect(wouldDedupe(initial)).toBe(true);
  });

  it('el re-pedido idéntico nunca se deduplica contra la geometría pedida sin read-back', () => {
    const { positioned, apply, wouldDedupe } = wireUp();
    // Informe no X11 (unverified, sin read-back): el cache queda vacío.
    expect(apply({ status: 'unverified', bounds: null, read_back: false })).toBe(false);
    positioned.current = true;
    expect(wouldDedupe(initial)).toBe(false);
  });

  it('una colocación superseded no cachea: el re-pedido idéntico no se deduplica', () => {
    const { positioned, apply, wouldDedupe } = wireUp();
    expect(apply({ status: 'superseded', bounds: null, reason: 'superseded', read_back: false })).toBe(false);
    positioned.current = true;
    expect(wouldDedupe(initial)).toBe(false);
  });

  it('cuando el backend limita el tamaño, queda cacheada la concedida y el pedido vuelve a aplicarse', () => {
    const granted: PhysicalBounds = { ...initial, w: 314 };
    const { positioned, apply, wouldDedupe, report } = wireUp();
    expect(apply(report({ status: 'limited', reason: 'size_refused', bounds: granted }))).toBe(false);
    positioned.current = true;
    // El pedido original no coincide con lo concedido: el siguiente layout
    // idéntico re-aplica en vez de deduplicar contra la geometría pedida.
    expect(wouldDedupe(initial)).toBe(false);
    expect(wouldDedupe(granted)).toBe(true);
  });

  it('cierre y reapertura reinician exactamente como hoy: la primera colocación de la reapertura no se deduplica', () => {
    const { positioned, apply, resetForClose, wouldDedupe, report } = wireUp();
    expect(apply(report({ bounds: initial }))).toBe(false);
    positioned.current = true;
    expect(wouldDedupe(initial)).toBe(true);
    resetForClose();
    expect(wouldDedupe(initial)).toBe(false);
  });

  it('un informe `not_viewable` blando no cachea: un re-pedido idéntico re-aplica', () => {
    const { positioned, apply, wouldDedupe } = wireUp();
    expect(apply({ status: 'unverified', bounds: null, reason: 'not_viewable', read_back: false })).toBe(true);
    positioned.current = true;
    expect(wouldDedupe(initial)).toBe(false);
  });

  it('un cambio de proveedor o de DPI (bounds físicos nuevos) re-aplica la colocación', () => {
    const { positioned, apply, wouldDedupe, report } = wireUp();
    expect(apply(report({ bounds: initial }))).toBe(false);
    positioned.current = true;
    expect(wouldDedupe(initial)).toBe(true);
    // Los bounds físicos cambian: la dedupe con tolerancia ya no aplica.
    expect(wouldDedupe({ ...initial, y: initial.y - 40 })).toBe(false);
    expect(wouldDedupe({ ...initial, w: initial.w + 2, h: initial.h + 2 })).toBe(false);
  });
});
