/** Mirror of the Rust DisplayBackend (wm_compat.rs, serde lowercase). */
export type DisplayBackend = 'x11' | 'wayland';

/**
 * 'native': the window positions itself (X11/XWayland).
 * 'compositor': xdg-shell gesture (startDragging); the compositor moves it.
 */
export type DragMode = 'native' | 'compositor';

export interface DragDecision {
  mode: DragMode;
  allowSnap: boolean;
  allowPersist: boolean;
}

/**
 * Module-level decision store for the CURRENT session's drag mode.
 *
 * A widget-local `useRef` cannot be observed or reset by outside code: the SSR
 * test harness (`renderToStaticMarkup`) runs no React effects, so a ref stays
 * `null` forever and every simulated grip is blocked; and on a re-mounted
 * widget a ref either leaks a stale decision or re-detects from scratch with
 * no observable state in between. A module store is observable by tests and
 * resettable on unmount, and the decision is still fetched exactly once per
 * mount via `get_wm_info` (see the decision effect in `src/Widget.tsx`).
 *
 * `null` = unresolved: the grip must NOT start any drag yet (both defaults
 * from the mount effect). Otherwise 'native' or 'compositor', as decided by
 * `dragMode()` for the effective GDK backend (or the safe fallback).
 */
let storedDragMode: DragMode | null = null;

export const setDragMode = (mode: DragMode): void => {
  storedDragMode = mode;
};

export const currentDragMode = (): DragMode | null => storedDragMode;

export const resetDragMode = (): void => {
  storedDragMode = null;
};

/**
 * Single source of truth for #180 drag strategy, decided by the EFFECTIVE GDK
 * display backend (exposed as `displayBackend` in the get_wm_info response),
 * never by session type: `is_wayland_session_from_env` ignores
 * GDK_BACKEND=x11, so deciding by session would lose snap and persistence
 * exactly under XWayland, where the issue thread shows they work.
 *
 * X11 (including XWayland): gtk_window_move works, so snap on release and
 * persisting dockEdge/dockOffset/dockMonitor are both allowed.
 *
 * Wayland: under xdg-shell only the compositor controls position, the client
 * has no absolute position to consult, and a release edge computed from
 * unreliable coordinates could corrupt the shared config.json that X11
 * sessions also read — so neither snap nor persistence runs there.
 */
export function dragMode(backend: DisplayBackend): DragDecision {
  if (backend === 'x11') {
    return { mode: 'native', allowSnap: true, allowPersist: true };
  }
  return { mode: 'compositor', allowSnap: false, allowPersist: false };
}

/** Platform of the widget process, as classified by `osFromUA`. */
export type WidgetPlatform = 'windows' | 'macos' | 'linux';

/**
 * Detection-failure fallback when `get_wm_info` does not resolve (#180,
 * maintainer review minor of #210). Linux-only degradation: the compositor
 * gesture cannot touch config.json, so an unresolved probe is safe there.
 * Windows/macOS keep 'native' — a one-off probe failure must never remove
 * the magnet of the only drag pipeline those platforms have.
 */
export function fallbackDragMode(platform: WidgetPlatform): DragMode {
  return platform === 'linux' ? 'compositor' : 'native';
}
