import { describe, expect, it } from 'vitest';
import {
  forgetSurface,
  nextPointerTarget,
  pointerInsideWidget,
  shouldArmClose,
  type HoverEvent,
  type PointerTarget,
} from './hover-presence';

/** The target that follows a sequence of pointer events. */
const after = (current: PointerTarget, ...events: HoverEvent[]): PointerTarget =>
  events.reduce(nextPointerTarget, current);

describe('hover presence model', () => {
  it('arms the close when the detail reports leave even if the strip never reported mouseleave', () => {
    // The regression of #250: the strip's `mouseleave` is lost on Wayland
    // native, so the detail's own `leave` has to arm the close by itself.
    const target = after('outside', { surface: 'widget', kind: 'enter' }, { surface: 'detail', kind: 'enter' }, { surface: 'detail', kind: 'leave' });
    expect(target).toBe('outside');
    expect(shouldArmClose(target)).toBe(true);
  });

  it('arms the close when the strip reports leave and the pointer is outside both surfaces', () => {
    const target = after('outside', { surface: 'widget', kind: 'enter' }, { surface: 'widget', kind: 'leave' });
    expect(target).toBe('outside');
    expect(shouldArmClose(target)).toBe(true);
  });

  it('cancels the close when the detail reports enter (strip -> detail)', () => {
    const target = after('outside', { surface: 'widget', kind: 'enter' }, { surface: 'widget', kind: 'leave' }, { surface: 'detail', kind: 'enter' });
    expect(target).toBe('detail');
    expect(shouldArmClose(target)).toBe(false);
  });

  it('cancels the close when the strip reports enter (detail -> strip)', () => {
    const target = after('outside', { surface: 'detail', kind: 'enter' }, { surface: 'detail', kind: 'leave' }, { surface: 'widget', kind: 'enter' });
    expect(target).toBe('widget');
    expect(shouldArmClose(target)).toBe(false);
  });

  it('clears the strip presence when the detail reports enter', () => {
    const inStrip = after('outside', { surface: 'widget', kind: 'enter' });
    expect(pointerInsideWidget(inStrip)).toBe(true);
    // The pointer cannot be in the two windows at once: the strip's presence
    // is invalid, so its auto-hide is not frozen any more.
    const inDetail = nextPointerTarget(inStrip, { surface: 'detail', kind: 'enter' });
    expect(pointerInsideWidget(inDetail)).toBe(false);
  });

  it('ignores a leave from a surface the pointer is not on', () => {
    // A `mouseleave` that arrives after the detail's `enter` is stale: the
    // pointer is on the detail, so the popup must stay open.
    const target = nextPointerTarget('detail', { surface: 'widget', kind: 'leave' });
    expect(target).toBe('detail');
    expect(shouldArmClose(target)).toBe(false);
  });

  it('answers every event from the given state alone (no hidden state, no timers)', () => {
    const event: HoverEvent = { surface: 'detail', kind: 'leave' };
    const first = nextPointerTarget('detail', event);
    const second = nextPointerTarget('detail', event);
    expect(first).toBe(second);
    expect(first).toBe('outside');
    // The state is a value: the reducer cannot change it behind the caller.
    const state: PointerTarget = 'widget';
    nextPointerTarget(state, { surface: 'widget', kind: 'leave' });
    expect(state).toBe('widget');
  });

  it('forgets a surface that no longer exists and keeps the other one', () => {
    expect(forgetSurface('detail', 'detail')).toBe('outside');
    expect(forgetSurface('widget', 'detail')).toBe('widget');
    expect(forgetSurface('outside', 'detail')).toBe('outside');
  });
});
