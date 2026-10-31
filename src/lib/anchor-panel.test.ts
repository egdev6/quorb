// Las reglas del panel anclado (#170): un solo estado con el provider visible
// y si está anclado. El componente usa estas funciones; aquí se fija el
// contrato sin DOM ni servidor X.

import { describe, expect, it } from 'vitest';
import { clickPanel, closePanel, hoverPanel, isReorderGesture, NO_PANEL, panelHoldsOpen, REORDER_GUARD_MS } from './anchor-panel';

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
