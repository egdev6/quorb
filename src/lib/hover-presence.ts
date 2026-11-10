/**
 * Pointer presence of the two hover surfaces (#250, S16).
 *
 * The strip and the detail popup are two separate native windows and the
 * pointer crosses a gap between them. A compositor can drop the DOM
 * `mouseleave` of the strip (Wayland native), so a close decision that
 * depends on that single event is not deterministic: the popup stayed open
 * until the user clicked the orb.
 *
 * The model keeps the pointer's location as its state, so the close decision
 * never depends on one flag that one surface owns:
 *
 * - `widget enter` -> `widget`
 * - `widget leave` -> `outside`
 * - `detail enter` -> `detail`
 * - `detail leave` -> `outside`
 *
 * The close timer is armed only while the target is `outside`.
 *
 * Two invariants make the decision deterministic:
 *
 * 1. The pointer cannot be in two windows at once. The detail's `enter`
 *    therefore invalidates the strip's presence even when the strip's
 *    `mouseleave` never arrives, and the strip's presence is derived from the
 *    model instead of being a flag of its own.
 * 2. A `leave` only clears the surface it belongs to. A `leave` from a
 *    surface the pointer is not on is stale (the other surface still holds
 *    it) and changes nothing. Without this rule a `mouseleave` that arrives
 *    after the detail's `enter` would close a popup the user is reading, and
 *    the native presence sampler (macOS) could not correct it in time.
 */

/** Where the pointer is, as far as the surfaces can tell. */
export type PointerTarget = 'widget' | 'detail' | 'outside';

/** The two surfaces the pointer can be on. */
export type HoverSurface = 'widget' | 'detail';

/** A pointer transition reported by one surface. */
export interface HoverEvent {
  surface: HoverSurface;
  kind: 'enter' | 'leave';
}

/**
 * The target that follows a pointer event.
 *
 * An `enter` always wins: the pointer is on that surface now, and it cannot
 * be on the other one at the same time. A `leave` clears the surface it
 * belongs to; a leave from a surface the pointer is not on is stale and
 * leaves the target alone.
 */
export function nextPointerTarget(current: PointerTarget, event: HoverEvent): PointerTarget {
  if (event.kind === 'enter') return event.surface;
  return current === event.surface ? 'outside' : current;
}

/** The close timer is armed only while the pointer is outside both surfaces. */
export function shouldArmClose(target: PointerTarget): boolean {
  return target === 'outside';
}

/** The strip's own presence, derived from the model. */
export function pointerInsideWidget(target: PointerTarget): boolean {
  return target === 'widget';
}

/**
 * Forget a surface that no longer exists (its window was closed): the pointer
 * is not on it any more, and the other surface keeps its own presence.
 */
export function forgetSurface(target: PointerTarget, surface: HoverSurface): PointerTarget {
  return target === surface ? 'outside' : target;
}
