// Contrato del informe nativo y del reintento de la colocación del detail (#215).
//
// El backend es la autoridad: responde con lo que quedó en pantalla (read-back de
// X11) o con un informe blando si no pudo confirmar. Estas pruebas fijan la
// disciplina de caché — la solicitud **nunca** se cachea como confirmada (S3/D2) —
// y el reintento silencioso tras `show()` cuando la ventana aún no era legible
// (#221: mismas primitivas que la tira, nunca duplicadas).

import { describe, expect, it, vi } from 'vitest';
import {
  confirmDetailPlacement,
  decideDetailPlacement,
  retryDetailPlacement,
  type DetailPlacementReport,
} from './detail-placement';
import { samePlacement } from './lib/widget-placement';
import type { PhysicalBounds } from './lib/detail-panel';

const requested: PhysicalBounds = { x: 120, y: 900, w: 330, h: 379 };
const granted: PhysicalBounds = { x: 120, y: 900, w: 314, h: 379 };

const report = (over: Partial<DetailPlacementReport> = {}): DetailPlacementReport => ({
  status: 'applied',
  bounds: granted,
  read_back: true,
  ...over,
});

/** X11 con la ventana aún oculta: blando, sin geometría, reintento tras `show()`. */
const notViewable = (): DetailPlacementReport => ({
  status: 'unverified', bounds: null, reason: 'not_viewable', read_back: false,
});

/** No Linux / Wayland nativo: la petición se aplicó y no hay read-back (S1). */
const nonX11 = (): DetailPlacementReport => ({
  status: 'unverified', bounds: null, read_back: false,
});

describe('decideDetailPlacement', () => {
  it('caches only the report geometry with read-back; the request never caches as confirmed', () => {
    const decision = decideDetailPlacement(report());
    expect(decision.bounds).toEqual(granted);
    expect(decision.retry).toBe(false);
  });

  it('nothing is cacheable without read-back, even if bounds are present', () => {
    // Nunca lo produce este backend, pero el contrato no cachea nada sin
    // confirmar (defensa en profundidad de S3).
    const decision = decideDetailPlacement(report({ read_back: false }));
    expect(decision.bounds).toBeNull();
    expect(decision.retry).toBe(false);
  });

  it('the non-X11 report (unverified, without geometry) caches nothing and does not retry', () => {
    const decision = decideDetailPlacement(nonX11());
    expect(decision).toEqual({ bounds: null, retry: false });
  });

  it('a failed read caches nothing and does not retry', () => {
    const decision = decideDetailPlacement({ status: 'unverified', bounds: null, reason: 'read_failed', read_back: false });
    expect(decision).toEqual({ bounds: null, retry: false });
  });

  it('a superseded placement caches nothing (the geometry was left half-done)', () => {
    const decision = decideDetailPlacement({ status: 'superseded', bounds: null, reason: 'superseded', read_back: false });
    expect(decision).toEqual({ bounds: null, retry: false });
  });

  it('`not_viewable` is soft: it caches nothing and asks for a retry after `show()`', () => {
    const decision = decideDetailPlacement(notViewable());
    expect(decision).toEqual({ bounds: null, retry: true });
  });
});

describe('confirmDetailPlacement', () => {
  it('caches the confirmed geometry and does not ask for a retry', () => {
    const cached: PhysicalBounds[] = [];
    expect(confirmDetailPlacement(report(), (b) => { cached.push(b); })).toBe(false);
    expect(cached).toEqual([granted]);
  });

  it('the cache is the effective geometry, never the requested one', () => {
    const cached: PhysicalBounds[] = [];
    confirmDetailPlacement(report({ bounds: { x: 7, y: 8, w: 314, h: 379 } }), (b) => { cached.push(b); });
    expect(cached).toEqual([{ x: 7, y: 8, w: 314, h: 379 }]);
    expect(cached[0]).not.toEqual(requested);
  });

  it('limited (`size_refused`) caches the granted geometry, read-back, without a retry', () => {
    const cached: PhysicalBounds[] = [];
    const limited: DetailPlacementReport = report({ status: 'limited', reason: 'size_refused', bounds: granted });
    expect(confirmDetailPlacement(limited, (b) => { cached.push(b); })).toBe(false);
    expect(cached).toEqual([granted]);
  });

  it('a `not_viewable` report caches nothing and asks for a retry', () => {
    const cached: PhysicalBounds[] = [];
    expect(confirmDetailPlacement(notViewable(), (b) => { cached.push(b); })).toBe(true);
    expect(cached).toEqual([]);
  });

  it('the non-X11 report caches nothing without a retry: same flow as today', () => {
    const cached: PhysicalBounds[] = [];
    expect(confirmDetailPlacement(nonX11(), (b) => { cached.push(b); })).toBe(false);
    expect(cached).toEqual([]);
  });

  it('superseded and read_failed cache nothing: soft, always readable open', () => {
    for (const soft of [
      { status: 'superseded', bounds: null, reason: 'superseded', read_back: false },
      { status: 'unverified', bounds: null, reason: 'read_failed', read_back: false },
    ] as DetailPlacementReport[]) {
      const cached: PhysicalBounds[] = [];
      expect(confirmDetailPlacement(soft, (b) => { cached.push(b); })).toBe(false);
      expect(cached).toEqual([]);
    }
  });
});

describe('retryDetailPlacement (#221 pattern)', () => {
  /** Devuelve los informes de la secuencia, repitiendo el último. */
  const placeFor = (reports: DetailPlacementReport[]) => {
    const bounds: PhysicalBounds[] = [];
    let index = 0;
    return {
      place: vi.fn(async (b: PhysicalBounds) => {
        bounds.push(b);
        return reports[Math.min(index++, reports.length - 1)];
      }),
      bounds,
    };
  };

  const io = (place: (b: PhysicalBounds) => Promise<DetailPlacementReport>, over: Partial<Parameters<typeof retryDetailPlacement>[1]> = {}) =>
    ({ place, isCurrent: () => true, sleep: async () => {}, ...over } as Parameters<typeof retryDetailPlacement>[1]);

  it('re-asks exactly the requested placement while the window is not viewable', async () => {
    const { place, bounds } = placeFor([notViewable(), notViewable(), report()]);
    const result = await retryDetailPlacement(requested, io(place));
    // Misma solicitud en cada reintento; el último informe (applied) vuelve al
    // llamante, que entonces cachea la geometría confirmada.
    expect(place).toHaveBeenCalledTimes(3);
    expect(bounds).toEqual([requested, requested, requested]);
    expect(result).toEqual(report({ reason: undefined }));
  });

  it('gives up after the bounded budget without any real failure', async () => {
    const { place } = placeFor([notViewable()]);
    const result = await retryDetailPlacement(requested, io(place, { attempts: 4 }));
    expect(place).toHaveBeenCalledTimes(4);
    expect(result).toEqual(notViewable());
  });

  it('returns null without asking when the detail already closed or changed', async () => {
    const { place } = placeFor([report()]);
    const result = await retryDetailPlacement(requested, io(place, { isCurrent: () => false }));
    expect(place).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('stops between reads when the detail closed or changed meanwhile', async () => {
    let places = 0;
    const { place: rawPlace } = placeFor([notViewable()]);
    const place = async (b: PhysicalBounds) => {
      const r = await rawPlace(b);
      places += 1;
      return r;
    };
    const result = await retryDetailPlacement(requested, io(place, { isCurrent: () => places < 2 }));
    expect(places).toBe(2);
    expect(result).toBeNull();
  });
});

/**
 * Invariante de cableado del efecto de layout: sobre una caché con geometría
 * confirmada la misma solicitud se deduplica (tolerancia ±1 px del read-back),
 * y una caché vacía —softs— deduplica nada. Es la condición literal de salida
 * temprana del panel: `samePlacement(cached, requested, readBack)`.
 */
describe('dedupe sobre la caché de lastApplied', () => {
  it('la geometría confirmada con read-back admite la tolerancia; sin caché, no', () => {
    // El backend concedió 314 frente a 330 pedidos: nunca se deduplica contra
    // la solicitud; un re-pedido igual a lo concedido sí deduplica.
    expect(samePlacement(granted, requested, true)).toBe(false);
    expect(samePlacement(granted, { ...granted, x: granted.x + 1 }, true)).toBe(true);
    expect(samePlacement(null, requested, true)).toBe(false);
    expect(samePlacement(null, requested, false)).toBe(false);
  });
});
