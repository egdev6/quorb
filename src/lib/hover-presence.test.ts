import { describe, expect, it } from 'vitest';
import {
  forgetSurface,
  nextPointerTarget,
  pointerInsideWidget,
  shouldArmClose,
  STALE_LEAVE_WINDOW_MS,
  type HoverEvent,
  type HoverSurface,
  type PointerPresence,
} from './hover-presence';

/** The presence before any event: the pointer is nowhere known. */
const outside = (at = 0): PointerPresence => ({ target: 'outside', at });

/** A pointer transition at a given instant (ms since the epoch). */
const transition = (surface: HoverSurface, kind: 'enter' | 'leave', at: number): HoverEvent => ({ surface, kind, at });

/** The presence that follows a sequence of pointer events. */
const after = (presence: PointerPresence, ...events: HoverEvent[]): PointerPresence =>
  events.reduce((current, event) => nextPointerTarget(current, event), presence);

describe('hover presence model', () => {
  it('arms the close when the detail reports leave even if the strip never reported mouseleave', () => {
    // The regression of #250: the strip's `mouseleave` is lost on Wayland
    // native, so the detail's own `leave` has to arm the close by itself.
    const presence = after(
      outside(),
      transition('widget', 'enter', 0),
      transition('detail', 'enter', 0),
      transition('detail', 'leave', 0),
    );
    expect(presence.target).toBe('outside');
    expect(shouldArmClose(presence.target)).toBe(true);
  });

  it('arms the close when the strip reports leave and the pointer is outside both surfaces', () => {
    const presence = after(outside(), transition('widget', 'enter', 0), transition('widget', 'leave', 0));
    expect(presence.target).toBe('outside');
    expect(shouldArmClose(presence.target)).toBe(true);
  });

  it('cancels the close when the detail reports enter (strip -> detail)', () => {
    const presence = after(
      outside(),
      transition('widget', 'enter', 0),
      transition('widget', 'leave', 0),
      transition('detail', 'enter', 0),
    );
    expect(presence.target).toBe('detail');
    expect(shouldArmClose(presence.target)).toBe(false);
  });

  it('cancels the close when the strip reports enter (detail -> strip)', () => {
    const presence = after(
      outside(),
      transition('detail', 'enter', 0),
      transition('detail', 'leave', 0),
      transition('widget', 'enter', 0),
    );
    expect(presence.target).toBe('widget');
    expect(shouldArmClose(presence.target)).toBe(false);
  });

  it('clears the strip presence when the detail reports enter', () => {
    const inStrip = after(outside(), transition('widget', 'enter', 0));
    expect(pointerInsideWidget(inStrip.target)).toBe(true);
    // The pointer cannot be in the two windows at once: the strip's presence
    // is invalid, so its auto-hide is not frozen any more.
    const inDetail = nextPointerTarget(inStrip, transition('detail', 'enter', 0));
    expect(pointerInsideWidget(inDetail.target)).toBe(false);
  });

  it('ignores a leave from a surface the pointer is not on', () => {
    // A `mouseleave` that arrives right after the detail's `enter` is stale:
    // the pointer is on the detail, so the popup must stay open.
    const presence = nextPointerTarget({ target: 'detail', at: 1000 }, transition('widget', 'leave', 1010));
    expect(presence.target).toBe('detail');
    expect(shouldArmClose(presence.target)).toBe(false);
  });

  // #264/S13: el modelo no puede quedarse pegado a una presencia vieja. Una
  // salida que llega mucho después de la evidencia de la otra superficie es
  // autoridad: si la salida de esa superficie se pierde, es la única evidencia
  // real que queda del puntero.
  it('closes when the strip leaves long after the detail entered (#264/S13)', () => {
    const presence = after(
      outside(),
      transition('widget', 'enter', 0),
      transition('detail', 'enter', 0),
    );
    expect(presence.target).toBe('detail');
    const late = nextPointerTarget(presence, transition('widget', 'leave', 3000));
    expect(late.target).toBe('outside');
    expect(shouldArmClose(late.target)).toBe(true);
  });

  // #264/S14: la protección que motivó la regla de "leave viejo" sigue
  // vigente: una salida pegada al `enter` de la otra superficie es el resto
  // del mismo gesto y no cierra un panel que el usuario está leyendo.
  it('ignores the strip leave glued to the detail enter (#264/S14)', () => {
    const presence = after(
      outside(),
      transition('widget', 'enter', 0),
      transition('detail', 'enter', 0),
    );
    const glued = nextPointerTarget(presence, transition('widget', 'leave', 50));
    expect(glued.target).toBe('detail');
    expect(shouldArmClose(glued.target)).toBe(false);
  });

  it('uses the window as the boundary between a remainder and authority (#264/S13/S14)', () => {
    const evidence: PointerPresence = { target: 'detail', at: 1000 };
    const inside = nextPointerTarget(evidence, transition('widget', 'leave', 1000 + STALE_LEAVE_WINDOW_MS));
    expect(inside.target).toBe('detail');
    const outside = nextPointerTarget(evidence, transition('widget', 'leave', 1000 + STALE_LEAVE_WINDOW_MS + 1));
    expect(outside.target).toBe('outside');
  });

  it('answers every event from the given state alone (no hidden state, no timers)', () => {
    const event = transition('detail', 'leave', 10);
    const first = nextPointerTarget({ target: 'detail', at: 0 }, event);
    const second = nextPointerTarget({ target: 'detail', at: 0 }, event);
    expect(first).toEqual(second);
    expect(first.target).toBe('outside');
    // The state is a value: the reducer cannot change it behind the caller.
    const presence: PointerPresence = { target: 'widget', at: 0 };
    nextPointerTarget(presence, transition('widget', 'leave', 10));
    expect(presence.target).toBe('widget');
  });

  it('forgets a surface that no longer exists and keeps the other one', () => {
    expect(forgetSurface({ target: 'detail', at: 0 }, 'detail').target).toBe('outside');
    expect(forgetSurface({ target: 'widget', at: 0 }, 'detail').target).toBe('widget');
    expect(forgetSurface({ target: 'outside', at: 0 }, 'detail').target).toBe('outside');
  });
});
