/**
 * Windows text scale (#228). WebView2 renders at `devicePixelRatio`, which is the
 * monitor DPI scale times the Accessibility "Text size"; Tauri's `scaleFactor()`
 * only carries the DPI scale. Their ratio on the same window is the text scale,
 * global on Windows and therefore the same on every monitor.
 *
 * Geometry is computed in monitor units: CSS px only enter through `toMonitor`
 * and only leave through `toCss`; the single conversion to physical px stays
 * with the monitor scale factor.
 */

/** Windows text size range: 100 % to 225 %. */
export const TEXT_SCALE_MIN = 1;
export const TEXT_SCALE_MAX = 2.25;

const positive = (n: number) => Number.isFinite(n) && n > 0;

/** Text scale from one window's WebView ratio and monitor scale; 1 when unreadable. */
export function textScale(dpr: number, sf: number): number {
  if (!positive(dpr) || !positive(sf)) return 1;
  // Four decimals: float noise must never look like a new scale and re-place a window.
  return Math.round((dpr / sf) * 10000) / 10000;
}

/** CSS px of a WebView to monitor units. */
export function toMonitor(css: number, scale: number): number {
  return css * scale;
}

/** Monitor units to CSS px of a WebView. */
export function toCss(monitor: number, scale: number): number {
  return monitor / scale;
}

/**
 * One reading of the window: `devicePixelRatio` before and after awaiting the
 * asynchronous `scaleFactor()`.
 */
export interface TextScaleSample {
  dprBefore: number;
  sf: number;
  dprAfter: number;
}

/**
 * Next text scale from a sample, or the previous one. During a monitor change the
 * synchronous ratio and the asynchronous scale can belong to different monitors;
 * such a sample either moved while reading or falls outside what Windows allows.
 */
export function settleTextScale(previous: number, sample: TextScaleSample): number {
  const { dprBefore, sf, dprAfter } = sample;
  if (!positive(dprBefore) || !positive(sf) || dprBefore !== dprAfter) return previous;
  const next = textScale(dprBefore, sf);
  return next >= TEXT_SCALE_MIN && next <= TEXT_SCALE_MAX ? next : previous;
}
