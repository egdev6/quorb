/**
 * Native cursor presence for the hover detail popup (#154).
 *
 * On macOS a transparent, non-activating Webview can stop delivering DOM
 * mouseleave. The widget therefore samples the global cursor against both
 * native windows. Reconcile the first sample too: a quick exit can happen
 * before sampling starts, on Windows as well as macOS.
 *
 * DOM handlers remain the fast close path; native samples provide a fallback
 * using the same close timer, independently of stale DOM presence flags.
 */

import type { Os } from './os-detect';

export type PresenceSurface = 'widget' | 'detail';

/**
 * Does native presence sampling belong to this platform at all?
 *
 * Only where the DOM stops delivering the signal it is meant to supplement:
 * a transparent, non-activating macOS Webview can drop `mouseleave` (#154).
 * WebKitGTK does not fail there — `cursorPosition()` answers (0,0) — so the
 * sample reads "outside", and every 400 ms tick closes the popup the user
 * just opened. The DOM handlers stay the close path everywhere else.
 */
export function shouldSampleNativePresence(os: Os): boolean {
  return os === 'macos';
}

export interface DetailPresenceHooks {
  /** Popup currently open (a detail state is showing). */
  isOpen(): boolean;
  /** Start (or restart) the close timer. */
  scheduleClose(): void;
  /** Cancel a pending close timer. */
  cancelClose(): void;
}

export interface DetailPresence {
  /** Cursor transition for one surface (native or sampled). */
  cursor(surface: PresenceSurface, inside: boolean): void;
  /** Reconcile both surfaces atomically from a complete native sample. */
  sample(widget: boolean, detail: boolean): void;
  /** True while the cursor is over either surface. */
  isAnyInside(): boolean;
  /** Forget presence (popup closed by another path). */
  reset(): void;
}

export function createDetailPresence(hooks: DetailPresenceHooks): DetailPresence {
  const inside: Record<PresenceSurface, boolean> = { widget: false, detail: false };
  let reconciled = false;

  const sample = (widget: boolean, detail: boolean) => {
    const wasInside = inside.widget || inside.detail;
    const anyInside = widget || detail;
    inside.widget = widget;
    inside.detail = detail;
    // Repeated outside samples must not keep restarting the close delay.
    if (reconciled && wasInside === anyInside) return;
    reconciled = true;
    if (!hooks.isOpen()) return;
    if (anyInside) hooks.cancelClose();
    else hooks.scheduleClose();
  };

  return {
    cursor(surface, next) {
      sample(surface === 'widget' ? next : inside.widget, surface === 'detail' ? next : inside.detail);
    },
    sample,
    isAnyInside() {
      return inside.widget || inside.detail;
    },
    reset() {
      reconciled = false;
      inside.widget = false;
      inside.detail = false;
    },
  };
}

/** True when a global (physical-pixel) point lies inside native window bounds. */
export function pointInBounds(p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;
}

/**
 * Native presence of the global cursor over the popup surfaces, from one
 * sample. A surface with unknown bounds (`null`: query failed, e.g. Wayland)
 * is left untouched by the caller — sampling degrades, it never guesses.
 */
export function presenceFromPoint(
  point: { x: number; y: number },
  widget: { x: number; y: number; w: number; h: number } | null,
  detail: { x: number; y: number; w: number; h: number } | null,
): { widget: boolean; detail: boolean } {
  return {
    widget: !!widget && pointInBounds(point, widget),
    detail: !!detail && pointInBounds(point, detail),
  };
}
