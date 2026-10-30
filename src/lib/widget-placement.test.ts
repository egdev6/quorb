// Contrato de la colocación nativa de la tira (#179).
//
// El backend es la autoridad: la geometría que se cachea es la que él
// informó, no la solicitud. Estas pruebas fijan ese contrato, el del motivo
// que ve el usuario y el de la llamada IPC.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import {
  placementOutcome,
  reasonKey,
  samePhysicalWithin,
  samePlacement,
  type WidgetPlacementReason,
  type WidgetPlacementReport,
  type WidgetPlacementRequest,
} from './widget-placement';
import type { PhysicalBounds } from './detail-panel';

const requested: PhysicalBounds = { x: 1859, y: 899, w: 61, h: 181 };
const effective: PhysicalBounds = { x: 1859, y: 899, w: 61, h: 181 };

const report = (over: Partial<WidgetPlacementReport> = {}): WidgetPlacementReport => ({
  status: 'applied',
  bounds: effective,
  ...over,
});

/** El motivo que ve el usuario: el código se traduce con el catálogo ES/EN. */
const reasonText = (reason: WidgetPlacementReason | null, locale: 'es' | 'en' = 'es'): string | null => {
  if (!reason) return null;
  const key = reasonKey(reason);
  return key ? t(locale, key) : null;
};

describe('placementOutcome', () => {
  it('caches the geometry the backend reported, not the request', () => {
    const outcome = placementOutcome(report({ bounds: { x: 10, y: 20, w: 30, h: 40 } }), requested);
    expect(outcome.bounds).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it('asks for a retry and keeps the reason when the manager did not grant the geometry', () => {
    const outcome = placementOutcome(
      report({ status: 'limited', bounds: { x: 0, y: 0, w: 320, h: 260 }, reason: 'size_refused' }),
      requested,
    );
    expect(outcome.failed).toBe(true);
    // El motivo del backend llega al estado accesible del widget, localizado.
    expect(outcome.reason).toBe('size_refused');
    expect(reasonText(outcome.reason)).toBe('el gestor no concedió el tamaño');
    expect(outcome.bounds).toEqual({ x: 0, y: 0, w: 320, h: 260 });
  });

  it('keeps the current behaviour where there is no read-back', () => {
    // Wayland nativo, Windows y macOS no leen la geometría: no es un fallo.
    const outcome = placementOutcome(report({ status: 'unverified', bounds: null }), requested);
    expect(outcome.failed).toBe(false);
    expect(outcome.bounds).toEqual(requested);
  });

  it('does not cache a cancelled placement as a trustworthy drag origin', () => {
    // Una colocación cancelada quedó a medias: su geometría no es el origen.
    const outcome = placementOutcome(report({ status: 'superseded', bounds: null }), requested);
    expect(outcome.bounds).toBeNull();
    expect(outcome.failed).toBe(false);
  });

  it('does not cache anything when the native read failed', () => {
    const outcome = placementOutcome(
      report({ status: 'unverified', bounds: null, reason: 'read_failed' }),
      requested,
    );
    expect(outcome.bounds).toBeNull();
    expect(outcome.failed).toBe(true);
    expect(outcome.reason).toBe('read_failed');
    expect(reasonText(outcome.reason)).toBe('no se pudo leer la geometría nativa');
  });

  it('does not cache anything when the native window was not viewable yet', () => {
    // Sin lectura no hay geometría fiable: la solicitud tampoco se cachea y
    // el motivo llega al reintento.
    const outcome = placementOutcome(
      report({ status: 'unverified', bounds: null, reason: 'not_viewable' }),
      requested,
    );
    expect(outcome.bounds).toBeNull();
    expect(outcome.failed).toBe(true);
    expect(outcome.reason).toBe('not_viewable');
    expect(reasonText(outcome.reason)).toBe('la ventana nativa todavía no es visible');
    expect(reasonText(outcome.reason, 'en')).toBe('the native window is not visible yet');
  });

  it('caches the requested geometry when the backend does not answer', () => {
    // Sin informe del backend no hay lectura: se conserva la geometría pedida
    // (sin darla por verificada), que es lo que el widget puede arrastrar.
    const outcome = placementOutcome(undefined, requested);
    expect(outcome.bounds).toEqual(requested);
    expect(outcome.failed).toBe(false);
    expect(outcome.reason).toBeNull();
  });
});

describe('the reason codes', () => {
  it('maps every backend code to its catalog key', () => {
    expect(reasonKey('size_refused')).toBe('widget.reasonSizeRefused');
    expect(reasonKey('position_refused')).toBe('widget.reasonPositionRefused');
    expect(reasonKey('not_viewable')).toBe('widget.reasonNotViewable');
    expect(reasonKey('read_failed')).toBe('widget.reasonReadFailed');
    expect(reasonKey('superseded')).toBe('widget.reasonSuperseded');
    expect(reasonKey(null)).toBeNull();
    expect(reasonKey(undefined)).toBeNull();
  });

  it('carries no user-facing text: every key is translated by the catalog', () => {
    const codes: WidgetPlacementReason[] = [
      'size_refused',
      'position_refused',
      'not_viewable',
      'read_failed',
      'superseded',
    ];
    for (const code of codes) {
      const key = reasonKey(code)!;
      // La clave existe en los dos catálogos y su texto no es la clave.
      expect(t('es', key), `es · ${code}`).not.toBe(key);
      expect(t('en', key), `en · ${code}`).not.toBe(key);
    }
  });
});

describe('the dedup tolerance', () => {
  it('treats a geometry rounded by the window manager as the same one', () => {
    // El backend redondea a píxeles de dispositivo: con escala 1,5 la
    // diferencia es de 1 px físico y no debe re-emitir la colocación.
    expect(samePhysicalWithin({ x: 1859, y: 899, w: 62, h: 181 }, { x: 1859, y: 899, w: 61, h: 181 })).toBe(true);
    expect(samePhysicalWithin(null, requested)).toBe(false);
    // Un cambio real (2 px o más) sí se detecta: la tolerancia es menor que
    // el margen real, así que no hay oscilación.
    expect(samePhysicalWithin({ x: 1859, y: 899, w: 63, h: 181 }, requested)).toBe(false);
    expect(samePhysicalWithin({ x: 1859, y: 901, w: 61, h: 181 }, requested)).toBe(false);
    expect(samePhysicalWithin({ x: 1859, y: 899, w: 61, h: 181 }, requested)).toBe(true);
  });

  it('applies the tolerance only to the geometry that came from the X11 read-back', () => {
    // El read-back de X11: el gestor redondea el tamaño lógico a píxeles de
    // dispositivo, así que 1 px de diferencia es el mismo tamaño.
    expect(samePlacement({ x: 1859, y: 899, w: 62, h: 181 }, requested, true)).toBe(true);
    expect(samePlacement({ x: 1859, y: 899, w: 63, h: 181 }, requested, true)).toBe(false);
    // La posición también pasa por la conversión de escala (píxeles lógicos ⇄
    // físicos): 1 px de diferencia es la misma posición.
    expect(samePlacement({ x: 1860, y: 899, w: 61, h: 181 }, requested, true)).toBe(true);
    expect(samePlacement({ x: 1861, y: 899, w: 61, h: 181 }, requested, true)).toBe(false);
    // Sin read-back (Windows, macOS, Wayland nativo) un cambio de 1 px **sí**
    // es un cambio: la comparación es exacta.
    expect(samePlacement({ x: 1859, y: 899, w: 62, h: 181 }, requested, false)).toBe(false);
    expect(samePlacement({ x: 1860, y: 899, w: 61, h: 181 }, requested, false)).toBe(false);
    expect(samePlacement({ x: 1859, y: 899, w: 61, h: 181 }, requested, false)).toBe(true);
    // Y sin caché no hay comparación.
    expect(samePlacement(null, requested, true)).toBe(false);
    expect(samePlacement(null, requested, false)).toBe(false);
  });
});

describe('the read-back marker', () => {
  it('carries the read-back flag so only that geometry uses the tolerance', () => {
    const measured = placementOutcome(report({ read_back: true }), requested);
    expect(measured.readBack).toBe(true);
    expect(measured.bounds).toEqual(effective);
    // La ruta que no lee nada (Windows, macOS, Wayland nativo): comparación exacta.
    const plain = placementOutcome(report({ read_back: false }), requested);
    expect(plain.readBack).toBe(false);
    // Y un informe sin geometría no es un read-back.
    const none = placementOutcome(
      report({ status: 'unverified', bounds: null, reason: 'not_viewable' }),
      requested,
    );
    expect(none.readBack).toBe(false);
    expect(none.bounds).toBeNull();
  });
});

describe('the placement IPC contract', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@tauri-apps/api/core');
  });

  it('asks the backend for the placement with the anchored edge and the scale', async () => {
    const invoke = vi.fn(async () => report());
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }));
    const { api } = await import('./api');
    const placement: WidgetPlacementRequest = { ...requested, anchor: 'right', scale: 1.5 };
    expect(await api.setWidgetBounds(placement)).toEqual(report());
    expect(invoke).toHaveBeenCalledWith('set_widget_bounds', { bounds: placement });
  });

  it('cancels a pending placement when the strip starts to be dragged', async () => {
    const invoke = vi.fn(async () => undefined);
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }));
    const { api } = await import('./api');
    await api.cancelWidgetPlacement();
    expect(invoke).toHaveBeenCalledWith('cancel_widget_placement');
  });
});
