/**
 * Native cursor presence for the hover detail popup (#154).
 *
 * The popup's close path must not depend on DOM `mouseleave`: on macOS, a
 * Webview in a transparent, non-activating window can stop delivering
 * mouse-moved/exit events, and the popup then stays pinned forever. The
 * widget forwards tao's reliable window-level `CursorEntered`/`CursorLeft`
 * (tao emits them from native tracking rects) for the `widget` and `detail`
 * windows as a `detail-cursor-presence` event, and this tracker turns those
 * transitions into close scheduling.
 *
 * DOM `mouseleave` handlers keep working as before (Windows path); the
 * native presence is an additional, platform-independent guarantee, so both
 * sources converge on the same close timer owned by the widget.
 */

export type PresenceSurface = 'widget' | 'detail';

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
  /** True while the cursor is over either surface. */
  isAnyInside(): boolean;
  /** Forget presence (popup closed by another path). */
  reset(): void;
}

export function createDetailPresence(hooks: DetailPresenceHooks): DetailPresence {
  const inside: Record<PresenceSurface, boolean> = { widget: false, detail: false };

  return {
    cursor(surface, next) {
      if (inside[surface] === next) return; // duplicates are no-ops
      inside[surface] = next;
      if (next) {
        // Cursor reached a surface that must keep the popup alive.
        if (hooks.isOpen()) hooks.cancelClose();
        return;
      }
      if (hooks.isOpen() && !inside.widget && !inside.detail) hooks.scheduleClose();
    },
    isAnyInside() {
      return inside.widget || inside.detail;
    },
    reset() {
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
