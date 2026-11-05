// Las reglas del panel anclado (#170): un solo estado con el provider visible
// y si está anclado. El componente usa estas funciones; aquí se fija el
// contrato sin DOM ni servidor X.

import { describe, expect, it, vi } from 'vitest';
import {
  clickPanel,
  closePanel,
  createPanelCoordinator,
  canPointerOpen,
  hoverPanel,
  holdAfterReorderDrop,
  isReorderGesture,
  NO_PANEL,
  NO_REORDER_HOLD,
  releaseOnStripLeave,
  panelHoldsOpen,
  type PanelState,
  REORDER_GUARD_MS,
} from './anchor-panel';

describe('the anchored panel state', () => {
  it('starts closed', () => {
    expect(NO_PANEL).toEqual({ providerId: null, anchored: false });
  });

  it('anchors on click', () => {
    expect(clickPanel(NO_PANEL, 'openai')).toEqual({ providerId: 'openai', anchored: true });
  });

  it('unanchors and closes on a second click over the same orb', () => {
    const anchored = clickPanel(NO_PANEL, 'openai');
    expect(clickPanel(anchored, 'openai')).toEqual(NO_PANEL);
  });

  it('keeps the anchor when the click is over another orb', () => {
    const anchored = clickPanel(NO_PANEL, 'openai');
    expect(clickPanel(anchored, 'cursor')).toEqual({ providerId: 'cursor', anchored: true });
  });

  it('anchors over a transient panel opened by hover', () => {
    const transient = hoverPanel(NO_PANEL, 'openai');
    expect(clickPanel(transient, 'cursor')).toEqual({ providerId: 'cursor', anchored: true });
  });

  it('opens transiently on hover', () => {
    expect(hoverPanel(NO_PANEL, 'openai')).toEqual({ providerId: 'openai', anchored: false });
  });

  it('does not let the hover touch an anchored panel', () => {
    // El anclaje es deliberado: el puntero no lo puede cambiar por debajo.
    const anchored = clickPanel(NO_PANEL, 'openai');
    expect(hoverPanel(anchored, 'cursor')).toEqual(anchored);
  });

  it('closes the panel and the anchor together', () => {
    expect(closePanel()).toEqual(NO_PANEL);
  });

  it('holds open only while it is anchored', () => {
    expect(panelHoldsOpen(clickPanel(NO_PANEL, 'openai'))).toBe(true);
    expect(panelHoldsOpen(hoverPanel(NO_PANEL, 'openai'))).toBe(false);
  });

  it('unfocus callback only closes anchored panels and leaves transient unchanged', () => {
    // Al perder el foco de ambas ventanas, el anclado se cierra inmediatamente.
    // Pero si el panel era transitorio, no se toca el estado (su autocierre
    // programado de 280 ms o los 8 s del atajo no se cancela).
    const anchored = clickPanel(NO_PANEL, 'openai');
    const transient = hoverPanel(NO_PANEL, 'openai');

    const handleFocusLoss = (current: PanelState): PanelState => {
      if (!panelHoldsOpen(current)) return current;
      return closePanel();
    };

    expect(handleFocusLoss(anchored)).toEqual(NO_PANEL);
    expect(handleFocusLoss(transient)).toEqual(transient);
  });
});

describe('the reorder guard', () => {
  it('ignores the click that arrives right after a reorder', () => {
    // El clic llega después de soltar: la guarda es lo que lo frena, no el
    // umbral de 6 px (que ya se consumió en `pointerup`).
    expect(isReorderGesture(1000, 1000)).toBe(true);
    expect(isReorderGesture(1000, 1000 + REORDER_GUARD_MS - 1)).toBe(true);
  });

  it('lets the click anchor once the guard has passed', () => {
    expect(isReorderGesture(1000, 1000 + REORDER_GUARD_MS)).toBe(false);
  });

  it('does not treat a click without a reorder as a reorder gesture', () => {
    expect(isReorderGesture(0, 1000)).toBe(false);
  });
});

describe('the reorder hold (hover after a reorder, #222)', () => {
  it('holds the hover when a reorder is dropped with the pointer inside the strip', () => {
    expect(NO_REORDER_HOLD).toBe(false);
    expect(holdAfterReorderDrop(true)).toBe(true);
  });

  it('keeps the pointer from opening while held, however much time passes', () => {
    // El `mouseenter` diferido llega entre 0,2 s y 2,3 s después de soltar:
    // por eso `canPointerOpen` no recibe ninguna marca de tiempo.
    const held = holdAfterReorderDrop(true);
    expect(canPointerOpen.length).toBe(1);
    expect(canPointerOpen(held)).toBe(false);
    expect(canPointerOpen(held)).toBe(false);
  });

  it('releases the hold only with a real strip leave, and then the pointer opens', () => {
    const held = holdAfterReorderDrop(true);
    const released = releaseOnStripLeave(held);
    expect(released).toBe(false);
    expect(canPointerOpen(released)).toBe(true);
  });

  it('does not hold when the reorder is dropped outside the strip', () => {
    // Con la captura del puntero se puede soltar fuera de la ventana: su
    // `mouseleave` ya ocurrió y nada liberaría la retención después.
    const hold = holdAfterReorderDrop(false);
    expect(hold).toBe(false);
    expect(canPointerOpen(hold)).toBe(true);
  });

  it('keeps a strip leave idempotent while nothing is held', () => {
    expect(releaseOnStripLeave(NO_REORDER_HOLD)).toBe(false);
    expect(canPointerOpen(releaseOnStripLeave(NO_REORDER_HOLD))).toBe(true);
  });

  it('never changes the panel state: hover and click do not take the hold', () => {
    const states: PanelState[] = [NO_PANEL, { providerId: 'claude', anchored: false }, { providerId: 'claude', anchored: true }];
    const results = (state: PanelState) => ({
      hover: hoverPanel(state, 'codex'),
      click: clickPanel(state, 'codex'),
      close: closePanel(),
    });
    for (const state of states) {
      const held = holdAfterReorderDrop(true);
      const whileHeld = results(state);
      const released = releaseOnStripLeave(held);
      const afterRelease = results(state);
      expect(held).not.toBe(released);
      expect(afterRelease).toEqual(whileHeld);
      expect(hoverPanel.length).toBe(2);
      expect(clickPanel.length).toBe(2);
    }
  });
});

describe('the panel coordinator (delayed open and escape cancellation)', () => {
  it('cancels pending open when Escape is pressed before the delay expires', () => {
    let timerRun: (() => void) | null = null;
    const schedule = vi.fn((run: () => void) => {
      timerRun = run;
      return () => {
        timerRun = null;
      };
    });

    const onStateChange = vi.fn();
    const coordinator = createPanelCoordinator(onStateChange, { schedule });

    // 1. Foco o hover en un orbe programa la apertura con retardo
    coordinator.requestOpen('openai', 150);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toEqual(NO_PANEL);

    // 2. Escape se pulsa antes de que venza el retardo
    coordinator.escape();
    expect(coordinator.getState()).toEqual(NO_PANEL);
    expect(timerRun).toBeNull();

    // 3. El avance del temporizador no reabre el panel
    if (timerRun) (timerRun as () => void)();
    expect(coordinator.getState()).toEqual(NO_PANEL);
    expect(onStateChange).toHaveBeenLastCalledWith(NO_PANEL);
  });

  it('opens transiently if Escape is not pressed and the timer runs', () => {
    let timerRun: (() => void) | null = null;
    const schedule = vi.fn((run: () => void) => {
      timerRun = run;
      return () => {
        timerRun = null;
      };
    });

    const coordinator = createPanelCoordinator(() => {}, { schedule });
    coordinator.requestOpen('openai', 150);
    expect(coordinator.getState()).toEqual(NO_PANEL);

    // Vence el temporizador sin Escape
    if (timerRun) (timerRun as () => void)();
    expect(coordinator.getState()).toEqual({ providerId: 'openai', anchored: false });
  });

  it('cancels pending open when detail window emits escape', () => {
    let timerRun: (() => void) | null = null;
    const schedule = vi.fn((run: () => void) => {
      timerRun = run;
      return () => {
        timerRun = null;
      };
    });

    const coordinator = createPanelCoordinator(() => {}, { schedule });
    coordinator.requestOpen('openai', 150);

    // Cierre recibido por escape
    coordinator.escape();
    expect(timerRun).toBeNull();
    expect(coordinator.getState()).toEqual(NO_PANEL);
  });

  it('cancels pending open when a click anchors the panel', () => {
    let timerRun: (() => void) | null = null;
    const schedule = vi.fn((run: () => void) => {
      timerRun = run;
      return () => {
        timerRun = null;
      };
    });

    const coordinator = createPanelCoordinator(() => {}, { schedule });
    coordinator.requestOpen('openai', 150);
    coordinator.click('openai');

    expect(timerRun).toBeNull();
    expect(coordinator.getState()).toEqual({ providerId: 'openai', anchored: true });
  });

  it('ignores hover when panel is already anchored', () => {
    const schedule = vi.fn();
    const coordinator = createPanelCoordinator(() => {}, {
      initialState: { providerId: 'openai', anchored: true },
      schedule,
    });

    coordinator.requestOpen('cursor', 150);
    expect(schedule).not.toHaveBeenCalled();
    expect(coordinator.getState()).toEqual({ providerId: 'openai', anchored: true });
  });
});
