export interface SurfaceClip {
  width: number;
  height: number;
  /** Physical radii: top-left, top-right, bottom-right, bottom-left. */
  radii: [number, number, number, number];
}

/** Match the CSS surface after both its fit transform and monitor scaling. */
export function surfaceClipFor(size: { w: number; h: number }, radii: readonly number[], scale: number): SurfaceClip {
  if (![size.w, size.h].every((n) => Number.isInteger(n) && n > 0 && n <= 1_000_000) || !Number.isFinite(scale) || scale <= 0) {
    throw new Error('Invalid native surface dimensions');
  }
  const limit = Math.min(size.w, size.h) / 2;
  const radius = (n: number) => Number.isFinite(n) ? Math.min(limit, Math.max(0, n * scale)) : 0;
  return { width: size.w, height: size.h, radii: [radius(radii[0]), radius(radii[1]), radius(radii[2]), radius(radii[3])] };
}

/** Backdrop cosmetics must not prevent a usable widget/popup from appearing. */
export async function clipSurfaceSafely(clip: SurfaceClip, apply: (clip: SurfaceClip) => Promise<unknown>, report: (error: unknown) => void = console.warn, surface?: HTMLElement): Promise<void> {
  // The native mask clips only the backdrop; CSS must always clip foreground content.
  if (surface) delete surface.dataset.nativeRounded;
  try {
    await apply(clip);
  }
  catch (error) { report(error); }
}

/** Read computed radii: docked edges and dragging can override the theme radius. */
export function measureSurfaceClip(element: HTMLElement, size: { w: number; h: number }, scale: number): SurfaceClip {
  const style = getComputedStyle(element);
  return surfaceClipFor(size, [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(Number.parseFloat), scale);
}
