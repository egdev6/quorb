/**
 * The hold that a reorder puts on the strip (#264/S23, S28).
 *
 * Reordering an orb must not reopen the detail by itself (#222): the browser
 * sends the pointer's `mouseenter` again a few hundred milliseconds after the
 * drop, on the orb that ends up under the pointer. The hold covers that orb
 * and only that one, so reordering one orb does not turn the whole strip
 * blind.
 *
 * Two things are known at the drop and both name the orb to cover: the orb
 * that was dragged, and the orb under the pointer (a hit-test, because at
 * that instant the browser's own mouse state is still the one from before the
 * drag -- the pointer capture swallowed the moves -- and the `pointerup`'s
 * target is not reliable either, because the capture is lost during the
 * drag).
 *
 * The hold is released when the pointer leaves that orb. It is NOT released
 * by the boundary events that the drop itself causes: removing the preview
 * and applying the new order moves the orbs under the pointer, and those
 * events belong to that jump, not to the user (#264/S28). The hold is
 * therefore confirmed the first time the pointer is seen on the held orb,
 * and only a later exit releases it.
 */

/** Which orbs the hold covers, and whether the pointer has been on one of them. */
export interface ReorderHold {
  /** The orbs the hold covers: the dragged one and the one under the pointer. */
  orbIds: string[];
  /** Whether the pointer has been seen on one of them since the drop. */
  confirmed: boolean;
}

/** No hold: the hover opens every orb. */
export const NO_HOLD: ReorderHold = { orbIds: [], confirmed: false };

/**
 * The hold that a drop starts: the dragged orb and the one under the pointer.
 *
 * Without an orb under the pointer there is nothing to hold: the drop landed
 * on a gap of the strip or outside it. The deferred `enter` only ever arrives
 * on the orb that was under the pointer (#264/S27), so there is no `enter` to
 * stop; and a hold with no orb under the pointer would block an orb the
 * pointer is not on, with nothing left to release it (#264/S30, S31).
 */
export function holdOnDrop(draggedId: string | null, underId: string | null): ReorderHold {
  if (!underId) return NO_HOLD;
  const orbIds: string[] = [];
  for (const id of [draggedId, underId]) {
    if (id && !orbIds.includes(id)) orbIds.push(id);
  }
  return { orbIds, confirmed: false };
}

/** What the pointer entering an orb does to the hold. */
export interface OrbEnter {
  /** The hold after the entry. */
  hold: ReorderHold;
  /** Whether the detail must not open. */
  blocked: boolean;
}

/**
 * The pointer entered an orb.
 *
 * - The held orb does not open: that is the protection of #222.
 * - Any other orb opens: the hold does not cover the whole strip.
 * - Entering another orb means the pointer is not on the held one, so the
 *   hold ends with it. It is also the safety net for the browsers that lose
 *   the `mouseleave` of the orb (Wayland, #264/S16).
 */
export function onOrbEnter(hold: ReorderHold, orbId: string): OrbEnter {
  if (!hold.orbIds.length) return { hold, blocked: false };
  if (hold.orbIds.includes(orbId)) return { hold: { ...hold, confirmed: true }, blocked: true };
  // Another orb. The hold ends with it, but only once the pointer has been
  // seen on the held orb: before that, the entry belongs to the layout jump
  // that the drop causes (#264/S28).
  if (!hold.confirmed) return { hold, blocked: false };
  return { hold: NO_HOLD, blocked: false };
}

/**
 * The pointer left an orb.
 *
 * The hold ends when the pointer leaves the held orb: the rule the author
 * asked for ("the orb that stays blocked is that one, until the pointer
 * leaves it").
 *
 * A leave that arrives before the pointer has been seen on the held orb
 * belongs to the layout jump of the drop and does not release the hold:
 * otherwise the deferred `enter` would open the detail by itself on the
 * dropped orb (#222, #264/S28).
 */
export function onOrbLeave(hold: ReorderHold, orbId: string): ReorderHold {
  if (!hold.orbIds.includes(orbId)) return hold;
  if (!hold.confirmed) return hold;
  return NO_HOLD;
}

/** The part of the document the hit-test needs. */
interface HitTestDocument {
  elementFromPoint?: (x: number, y: number) => unknown;
}

/**
 * The orb under a viewport point, by hit-testing the document.
 *
 * The orbs expose their identity as `data-id`, and the closest orb of the
 * element at the point is the one the pointer is on. `null` when the point
 * is not on an orb (the gaps of the strip) or when there is no layout to
 * hit-test.
 */
export function orbIdAtPoint(x: number, y: number, doc?: HitTestDocument | null): string | null {
  const target = doc ?? (typeof document === 'undefined' ? null : document);
  let el: unknown = null;
  try {
    el = target?.elementFromPoint?.(x, y) ?? null;
  } catch {
    return null;
  }
  const orb = (el as { closest?: (s: string) => unknown } | null)?.closest?.('.orb[data-id]');
  const id = (orb as { getAttribute?: (n: string) => string | null } | null)?.getAttribute?.('data-id');
  return id ?? null;
}
