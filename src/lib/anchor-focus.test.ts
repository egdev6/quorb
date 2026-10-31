// El seam de foco (#170): el anclaje se suelta cuando el foco sale de las DOS
// ventanas propias (la tira y el detalle). El planificador manual hace el
// test determinista: no hay temporizadores reales ni servidor X.

import { describe, expect, it, vi } from 'vitest';
import { createFocusTracker, FOCUS_SETTLE_MS } from './anchor-focus';

/** Un planificador manual: el test dispara la comprobación cuando quiere. */
const manualScheduler = () => {
  let pending: (() => void) | null = null;
  let delay = 0;
  return {
    schedule: (run: () => void, ms: number) => {
      pending = run;
      delay = ms;
      return () => {
        pending = null;
      };
    },
    fire: () => {
      const run = pending;
      pending = null;
      run?.();
    },
    armed: () => pending !== null,
    delay: () => delay,
  };
};

describe('the focus tracker', () => {
  it('releases the anchor when neither of our windows keeps the focus', () => {
    const lost = vi.fn();
    const scheduler = manualScheduler();
    const tracker = createFocusTracker(lost, { schedule: scheduler.schedule });
    tracker.setFocus('widget', true);
    tracker.setFocus('widget', false);
    // Todavía dentro de la ventana de asentamiento: no se suelta nada.
    expect(lost).not.toHaveBeenCalled();
    scheduler.fire();
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('holds when the detail takes the focus (click inside the panel)', () => {
    const lost = vi.fn();
    const scheduler = manualScheduler();
    const tracker = createFocusTracker(lost, { schedule: scheduler.schedule });
    tracker.setFocus('widget', true);
    tracker.setFocus('widget', false);
    tracker.setFocus('detail', true);
    scheduler.fire();
    expect(lost).not.toHaveBeenCalled();
  });

  it('holds with the real event order: the loss arrives before the gain', () => {
    // La pérdida de la ventana antigua llega antes que la ganancia de la nueva
    // (X11, macOS y Windows lo hacen así): con el settling window aguanta.
    const lost = vi.fn();
    const scheduler = manualScheduler();
    const tracker = createFocusTracker(lost, { schedule: scheduler.schedule });
    tracker.setFocus('widget', true);
    tracker.setFocus('widget', false);
    expect(scheduler.armed()).toBe(true);
    tracker.setFocus('detail', true);
    expect(scheduler.armed()).toBe(false);
    scheduler.fire();
    expect(lost).not.toHaveBeenCalled();
  });

  it('waits the settle window before releasing', () => {
    const scheduler = manualScheduler();
    const tracker = createFocusTracker(vi.fn(), { schedule: scheduler.schedule });
    tracker.setFocus('widget', true);
    tracker.setFocus('widget', false);
    expect(scheduler.delay()).toBe(FOCUS_SETTLE_MS);
  });

  it('reports once until one of our windows takes the focus back', () => {
    const lost = vi.fn();
    const scheduler = manualScheduler();
    const tracker = createFocusTracker(lost, { schedule: scheduler.schedule });
    tracker.setFocus('widget', true);
    tracker.setFocus('widget', false);
    scheduler.fire();
    tracker.setFocus('widget', false);
    scheduler.fire();
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('reports again after the focus comes back', () => {
    const lost = vi.fn();
    const scheduler = manualScheduler();
    const tracker = createFocusTracker(lost, { schedule: scheduler.schedule });
    tracker.setFocus('widget', true);
    tracker.setFocus('widget', false);
    scheduler.fire();
    tracker.setFocus('widget', true);
    tracker.setFocus('widget', false);
    scheduler.fire();
    expect(lost).toHaveBeenCalledTimes(2);
  });

  it('cancel stops the pending check', () => {
    const lost = vi.fn();
    const scheduler = manualScheduler();
    const tracker = createFocusTracker(lost, { schedule: scheduler.schedule });
    tracker.setFocus('widget', true);
    tracker.setFocus('widget', false);
    tracker.cancel();
    scheduler.fire();
    expect(lost).not.toHaveBeenCalled();
  });
});
