import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDetailPresence, pointInBounds, presenceFromPoint } from './detail-presence';

/**
 * Deterministic tracker whose close bookkeeping records the ORDER of
 * schedule/cancel calls. The guarantee under test is about the final state:
 * after any transition sequence, a pending close exists iff the cursor is
 * outside both surfaces while the popup is open.
 */
function setup(isOpen: () => boolean = () => true) {
  vi.useFakeTimers();
  const calls: ('schedule' | 'cancel')[] = [];
  const scheduleClose = vi.fn(() => calls.push('schedule'));
  const cancelClose = vi.fn(() => calls.push('cancel'));
  const tracker = createDetailPresence({ isOpen, scheduleClose, cancelClose });
  const lastAction = () => calls[calls.length - 1] ?? 'none';
  return { tracker, scheduleClose, cancelClose, lastAction };
}
afterEach(() => vi.useRealTimers());

describe('createDetailPresence', () => {
  it('escenario #154: popup abierto, el DOM no emite mouseleave y el cursor nativo sale de ambas superficies → queda pendiente de cerrar', () => {
    const { tracker, lastAction } = setup();
    tracker.cursor('widget', true);
    tracker.cursor('widget', false); // sale del widget (tránsito)
    tracker.cursor('detail', true); // entra al panel
    tracker.cursor('detail', false); // sale del panel: fuera de ambas
    expect(lastAction()).toBe('schedule');
  });

  it('no deja cierre pendiente si el cursor sigue dentro del widget', () => {
    const { tracker, lastAction } = setup();
    tracker.cursor('widget', true);
    tracker.cursor('detail', false);
    expect(lastAction()).not.toBe('schedule');
  });

  it('no deja cierre pendiente si el cursor sigue dentro del panel', () => {
    const { tracker, lastAction } = setup();
    tracker.cursor('widget', true);
    tracker.cursor('widget', false);
    tracker.cursor('detail', true);
    expect(lastAction()).not.toBe('schedule');
  });

  it('con el popup cerrado no programa cierre ni toca timers', () => {
    const { tracker, scheduleClose, cancelClose, lastAction } = setup(() => false);
    tracker.cursor('widget', true);
    tracker.cursor('widget', false);
    tracker.cursor('detail', true);
    tracker.cursor('detail', false);
    expect(scheduleClose).not.toHaveBeenCalled();
    expect(cancelClose).not.toHaveBeenCalled();
    expect(lastAction()).toBe('none');
  });

  it('la re-entrada dentro del retardo cancela el cierre programado (tránsito widget→panel y de vuelta)', () => {
    const { tracker, lastAction } = setup();
    tracker.cursor('widget', true);
    tracker.cursor('widget', false);
    tracker.cursor('detail', true);
    expect(lastAction()).toBe('cancel');
    tracker.cursor('detail', false);
    tracker.cursor('widget', true);
    expect(lastAction()).toBe('cancel');
  });

  it('eventos repetidos idénticos son idempotentes (flujo real widget→panel→fuera)', () => {
    const { tracker, scheduleClose, cancelClose, lastAction } = setup();
    tracker.cursor('widget', true);
    tracker.cursor('widget', true); // duplicado: no-op
    tracker.cursor('widget', false); // tránsito al panel
    tracker.cursor('widget', false); // duplicado: no-op
    tracker.cursor('detail', true);
    tracker.cursor('detail', false); // fuera de ambas: cierre pendiente
    tracker.cursor('detail', false); // duplicado: no-op
    expect(scheduleClose).toHaveBeenCalledTimes(2);
    expect(cancelClose).toHaveBeenCalledTimes(2);
    expect(lastAction()).toBe('schedule');
    // Y una re-entrada posterior cancela: sin cierre pendiente.
    tracker.cursor('widget', true);
    expect(lastAction()).toBe('cancel');
  });

  it('isAnyInside refleja la unión de ambas superficies', () => {
    const { tracker } = setup();
    expect(tracker.isAnyInside()).toBe(false);
    tracker.cursor('detail', true);
    expect(tracker.isAnyInside()).toBe(true);
    tracker.cursor('detail', false);
    tracker.cursor('widget', true);
    expect(tracker.isAnyInside()).toBe(true);
    tracker.cursor('widget', false);
    expect(tracker.isAnyInside()).toBe(false);
  });

  it('reset olvida la presencia (popup cerrado por otra vía)', () => {
    const { tracker } = setup();
    tracker.cursor('widget', true);
    tracker.reset();
    expect(tracker.isAnyInside()).toBe(false);
    // Tras reset, la re-notificación del mismo valor vuelve a procesarse.
    const { tracker: t2, cancelClose } = setup();
    t2.cursor('widget', true);
    t2.reset();
    t2.cursor('widget', true);
    expect(cancelClose).toHaveBeenCalledTimes(2);
  });
});

describe('pointInBounds', () => {
  const b = { x: 100, y: 200, w: 300, h: 150 };
  it('contiene puntos interiores y en el borde izquierdo/superior', () => {
    expect(pointInBounds({ x: 250, y: 275 }, b)).toBe(true);
    expect(pointInBounds({ x: 100, y: 200 }, b)).toBe(true);
  });
  it('excluye bordes derecho/inferior y puntos exteriores', () => {
    expect(pointInBounds({ x: 400, y: 275 }, b)).toBe(false);
    expect(pointInBounds({ x: 250, y: 350 }, b)).toBe(false);
    expect(pointInBounds({ x: 99, y: 275 }, b)).toBe(false);
    expect(pointInBounds({ x: 250, y: 10000 }, b)).toBe(false);
  });
});

describe('presenceFromPoint', () => {
  const widget = { x: 0, y: 0, w: 100, h: 500 };
  const detail = { x: 100, y: 0, w: 330, h: 260 };
  it('clasifica el punto por superficie', () => {
    expect(presenceFromPoint({ x: 50, y: 250 }, widget, detail)).toEqual({ widget: true, detail: false });
    expect(presenceFromPoint({ x: 200, y: 100 }, widget, detail)).toEqual({ widget: false, detail: true });
    expect(presenceFromPoint({ x: 1000, y: 1000 }, widget, detail)).toEqual({ widget: false, detail: false });
  });
  it('con bounds desconocidos la superficie no se puede afirmar', () => {
    expect(presenceFromPoint({ x: 50, y: 250 }, widget, null)).toEqual({ widget: true, detail: false });
    expect(presenceFromPoint({ x: 50, y: 250 }, null, null)).toEqual({ widget: false, detail: false });
  });
});
