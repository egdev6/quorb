/**
 * Pointer presence of the two hover surfaces (#250, S16; #264, S13/S14).
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
 * Three invariants make the decision deterministic:
 *
 * 1. The pointer cannot be in two windows at once. The detail's `enter`
 *    therefore invalidates the strip's presence even when the strip's
 *    `mouseleave` never arrives, and the strip's presence is derived from the
 *    model instead of being a flag of its own.
 * 2. A `leave` only clears the surface it belongs to. A `leave` from the
 *    other surface does not clear it: the pointer is on that other surface,
 *    not on the one that reported the leave.
 * 3. That `leave` is not ignored forever (#264/S13). When it arrives long
 *    after the evidence of the surface that holds the pointer, it is the only
 *    evidence left and it is authority: the pointer is outside. The
 *    discriminator is the elapsed time, not the last state (#264/S14): a
 *    `leave` glued to the other surface's `enter` is the remainder of the
 *    same gesture and must not close a panel the user is reading (#250,
 *    S11).
 */

/** Where the pointer is, as far as the surfaces can tell. */
export type PointerTarget = 'widget' | 'detail' | 'outside';

/** The two surfaces the pointer can be on. */
export type HoverSurface = 'widget' | 'detail';

/**
 * How long a `leave` may arrive after the evidence of the surface that holds
 * the pointer and still be taken as the remainder of the same gesture
 * (#264/S14).
 *
 * The pointer crosses a gap between the two windows: the strip's
 * `mouseleave` and the detail's `mouseenter` are part of the same movement
 * and arrive a few milliseconds apart. That `leave` must not close a panel
 * the user is reading (#250, S11). A `leave` that arrives much later is not
 * a remainder: it is the only evidence left about the pointer, so it closes
 * (#264/S13).
 */
export const STALE_LEAVE_WINDOW_MS = 250;

/** A pointer transition reported by one surface. */
export interface HoverTransition {
  surface: HoverSurface;
  kind: 'enter' | 'leave';
}

/**
 * The event with which the backend relays the native pointer transitions
 * (#264/S16).
 *
 * GTK delivers `enter-notify-event`/`leave-notify-event` for a window even
 * when WebKitGTK does not translate them into DOM events, so the native
 * signal is forwarded to the frontend and consumed as another source of
 * presence for that surface.
 */
export const POINTER_SURFACE_EVENT = 'pointer-surface';

/** The payload of the native relay: the surface and the transition. */
export interface PointerSurfacePayload {
  surface: HoverSurface;
  kind: 'enter' | 'leave';
}

/** A pointer transition and the instant it happened (ms since the epoch). */
export interface HoverEvent extends HoverTransition {
  at: number;
}

/**
 * The presence of the pointer: where it is, and the instant of the
 * observation that put it there.
 */
export interface PointerPresence {
  /** Where the pointer is. */
  target: PointerTarget;
  /** Instant of the observation behind `target` (ms since the epoch). */
  at: number;
}

/**
 * The presence that follows a pointer event.
 *
 * An `enter` always wins: the pointer is on that surface now, and it cannot
 * be on the other one at the same time. A `leave` clears the surface it
 * belongs to. A `leave` from the other surface is ambiguous — the remainder
 * of the same gesture, or the only evidence left — and the time elapsed
 * since the evidence that holds the pointer decides (#264/S13/S14).
 */
export function nextPointerTarget(presence: PointerPresence, event: HoverEvent): PointerPresence {
  if (event.kind === 'enter') return { target: event.surface, at: event.at };
  // The pointer was on this surface and left it: the leave is authority.
  if (presence.target === event.surface) return { target: 'outside', at: event.at };
  // The pointer is not on this surface: the leave adds nothing.
  if (presence.target === 'outside') return presence;
  // The pointer is on the other surface. Within the window the leave is the
  // remainder of the same gesture and changes nothing; after it the leave is
  // the only evidence left, so the pointer is outside.
  return event.at - presence.at <= STALE_LEAVE_WINDOW_MS
    ? presence
    : { target: 'outside', at: event.at };
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
 *
 * The instant of the forgotten surface is void: the target becomes `outside`,
 * and `outside` never judges a later leave by time.
 */
export function forgetSurface(presence: PointerPresence, surface: HoverSurface): PointerPresence {
  return presence.target === surface ? { target: 'outside', at: presence.at } : presence;
}
