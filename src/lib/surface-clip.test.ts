import { describe, expect, it } from 'vitest';
import { surfaceClipFor, clipSurfaceSafely } from './surface-clip';

describe('native surface clipping', () => {
  it('converts each real CSS radius through panel fit and monitor DPI', () => {
    expect(surfaceClipFor({ w: 600, h: 900 }, [16, 16, 16, 16], 0.75 * 2)).toEqual({
      width: 600, height: 900, radii: [24, 24, 24, 24],
    });
  });
  it('preserves the square docked edge rather than assuming four round corners', () => {
    expect(surfaceClipFor({ w: 400, h: 80 }, [14, 14, 0, 0], 1.25).radii).toEqual([17.5, 17.5, 0, 0]);
    expect(surfaceClipFor({ w: 80, h: 400 }, [0, 14, 14, 0], 1).radii).toEqual([0, 14, 14, 0]);
  });
  it('clamps oversized radii and sanitizes invalid or negative radii', () => {
    expect(surfaceClipFor({ w: 400, h: 80 }, [9999, -1, NaN, 9999], 1).radii).toEqual([40, 0, 0, 40]);
    expect(surfaceClipFor({ w: 400, h: 79 }, [9999, 9999, 9999, 9999], 1.25).radii).toEqual([39.5, 39.5, 39.5, 39.5]);
    expect(surfaceClipFor({ w: 400, h: 200 }, [14, 0, 8, 12], 0.75 * 1.25).radii).toEqual([13.125, 0, 7.5, 11.25]);
  });
  it('leaves the thin auto-hide activation area fully rectangular', () => {
    expect(surfaceClipFor({ w: 400, h: 5 }, [0, 0, 0, 0], 2).radii).toEqual([0, 0, 0, 0]);
  });
  it('allows the UI to show even if the native clip fails', async () => {
    const clip = surfaceClipFor({ w: 400, h: 80 }, [14, 14, 14, 14], 1);
    const errors: unknown[] = [];
    const events: string[] = [];
    await clipSurfaceSafely(clip, async () => { throw new Error('GDI failed'); }, (error) => errors.push(error));
    events.push('show');
    expect(events).toEqual(['show']);
    expect(errors).toHaveLength(1);
    await expect(clipSurfaceSafely(clip, async () => true)).resolves.toBeUndefined();
  });
  it('keeps CSS corner ownership when the native layer is clipped independently', async () => {
    const clip = surfaceClipFor({ w: 400, h: 80 }, [14, 14, 14, 14], 1);
    const surface = { dataset: { nativeRounded: 'true' } } as unknown as HTMLElement;
    await clipSurfaceSafely(clip, async () => true, () => {}, surface);
    expect(surface.dataset.nativeRounded).toBeUndefined();
    surface.dataset.nativeRounded = 'true';
    await clipSurfaceSafely(clip, async () => { throw new Error('Composition unavailable'); }, () => {}, surface);
    expect(surface.dataset.nativeRounded).toBeUndefined();
  });
  it('rejects invalid native dimensions and scaling', () => {
    expect(() => surfaceClipFor({ w: 0, h: 80 }, [14, 14, 14, 14], 1)).toThrow();
    expect(() => surfaceClipFor({ w: 400, h: 80 }, [14, 14, 14, 14], NaN)).toThrow();
  });
});
