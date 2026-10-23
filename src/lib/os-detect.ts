/**
 * Which of the three platforms Quorb ships for is serving this webview.
 *
 * The UA is the only platform signal the frontend has, and it is injected so
 * the gates stay testable. It deliberately says nothing about the compositor:
 * X11 and Wayland are indistinguishable here, which is why the desktop-surface
 * decision comes from the backend (`get_wm_info` → `wm_compat.rs`, #128).
 *
 * One helper, one order. The three inline regexes this replaces disagreed on
 * edge cases, and the gates they feed (`OPEN_DELAY`, the DWM recovery loop of
 * #148, the cursor presence sampling of #154) are each platform-scoped for a
 * different reason — so a divergence between them is a silent behavior change.
 */

/** Windows, macOS, or everything else (Linux, and its mobile/other variants). */
export type Os = 'windows' | 'macos' | 'linux';

/**
 * `linux` is the honest "the rest" bucket, not a claim about the kernel.
 * Callers that must exclude Android (mobile UAs also say `Linux`) keep their own
 * `/Linux/ && !/Android/` test — see `showDesktopCompat()` in desktop-compat.ts.
 * `Windows` is checked first on purpose: a UA naming both platforms must land on
 * Windows, and that order is part of the contract.
 */
export function osFromUA(ua: string): Os {
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos';
  return 'linux';
}

/**
 * How long a pointer sweep must rest on another orb before it opens the popup.
 *
 * Windows and macOS keep the original 90 ms: there the compositor and #164
 * already contain accidental opens, and a long delay is perceptible. Linux has
 * no containment net — the native presence sampling of #154 exists only on
 * macOS — so an accidental sweep reaches the other orb and 350 ms keeps the
 * popup legible instead of closing it under the pointer.
 */
export function openDelayForOs(os: Os): number {
  return os === 'windows' || os === 'macos' ? 90 : 350;
}