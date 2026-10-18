import { describe, expect, it } from 'vitest';
import {
  basePanelZoom,
  createLatestQueue,
  detailBounds,
  fitPanel,
  isCurrentDetailInteraction,
  panelScaleFromTransform,
  panelWidthFor,
  physicalPanelBounds,
  sameFit,
  samePhysical,
  type DetailPlacement,
} from './detail-panel';
import { contains, panelHeightLimit, stripRect, type Edge } from './dock';

const area = { x: -1920, y: -100, w: 1920, h: 900 };
const topStrip = stripRect(area, 'top', 0.5, 400, 80);

const placement = (over: Partial<DetailPlacement> = {}): DetailPlacement => ({
  area,
  strip: topStrip,
  edge: 'top',
  anchor: topStrip.x + 40,
  width: 300,
  maxHeight: panelHeightLimit(area, 'top', topStrip),
  ...over,
});

describe('panel fit', () => {
  it.each([24, 40, 56, 60, 80, 100])('adds exactly 50 logical pixels at orb size %s', (orb) => {
    const previous = Math.round(Math.min(460, Math.max(220, (330 * orb) / 60)));
    expect(panelWidthFor(orb)).toBe(previous + 50);
  });
  it('clamps the basal zoom to the orb range', () => {
    expect(basePanelZoom(56)).toBe(1);
    expect(basePanelZoom(20)).toBe(0.6);
    expect(basePanelZoom(200)).toBe(1.5);
  });

  it('uses the natural visible height and grows or shrinks with content', () => {
    const p = placement({ maxHeight: 900 });
    const small = fitPanel(p, 260, 1);
    const large = fitPanel(p, 720, 1);
    expect(small.height).toBe(260);
    expect(large.height).toBe(720);
    expect([small.scaled, large.scaled]).toEqual([false, false]);
    expect(large.zoom).toBe(1);
    // Width and baseline layout stay put while only the height follows the content.
    expect(large.width).toBe(300);
  });

  it('keeps content taller than the old width cap when the monitor allows it', () => {
    // The old model capped the height at min(width * 1.6, available) = 480 for a 300 px panel.
    const p = placement({ maxHeight: 900 });
    const fit = fitPanel(p, 760, 1);
    expect(fit.scaled).toBe(false);
    expect(fit.height).toBe(760);
    expect(fit.width).toBe(300);
  });

  it('measures the natural height in basal logical pixels', () => {
    const p = placement({ maxHeight: 800 });
    // 900 unscaled CSS px at a 0.75 basal zoom occupy 675 logical px.
    const fit = fitPanel(p, 900, 0.75);
    expect(fit.scaled).toBe(false);
    expect(fit.zoom).toBe(0.75);
    expect(fit.height).toBe(675);
  });

  it('scales the whole panel down proportionally when it exceeds the monitor', () => {
    const p = placement({ maxHeight: 450 });
    const fit = fitPanel(p, 2400, 1);
    expect(fit.scaled).toBe(true);
    expect(fit.height).toBe(450);
    expect(fit.zoom).toBeCloseTo(450 / 2400, 12);
    expect(fit.width).toBeCloseTo(300 * (450 / 2400), 12);
    // Width and height shrink by the same factor, never below the content.
    expect(fit.width / p.width).toBeCloseTo(fit.zoom, 12);
  });

  it('never exceeds the monitor nor reports a phantom pixel for float overshoot', () => {
    const p = placement({ maxHeight: 600 });
    const fit = fitPanel(p, 1000.1, 1);
    expect(fit.height).toBe(600);
    expect(fit.zoom).toBeCloseTo(600 / 1000.1, 12);
    expect(Math.ceil(fit.height)).toBe(600);
  });

  it('is idempotent so repeated observer runs never compound the scale', () => {
    // Live harness case: a 1374 px natural panel inside an 800 px work area must settle
    // at 800/1374, never at the squared factor produced by measuring a scaled rect.
    const p = placement({ maxHeight: 800 });
    const first = fitPanel(p, 1374, 1);
    const again = fitPanel(p, 1374, 1);
    expect(sameFit(first, again)).toBe(true);
    expect(again.zoom).toBeCloseTo(800 / 1374, 12);
    expect(again.height).toBe(800);
    expect(again.width).toBeCloseTo(300 * (800 / 1374), 12);
  });

  it('reads the applied scale from the committed transform', () => {
    expect(panelScaleFromTransform('scale(0.58224)')).toBeCloseTo(0.58224, 10);
    expect(panelScaleFromTransform('scale(1)')).toBe(1);
    // Degenerate values fall back to no scaling instead of dividing by zero.
    expect(panelScaleFromTransform('')).toBe(1);
    expect(panelScaleFromTransform('none')).toBe(1);
    expect(panelScaleFromTransform('scale(0)')).toBe(1);
  });

  it('compares fits with tolerance to skip redundant native work', () => {
    const a = fitPanel(placement({ maxHeight: 900 }), 300, 1);
    expect(sameFit(a, fitPanel(placement({ maxHeight: 900 }), 300, 1))).toBe(true);
    expect(sameFit(a, fitPanel(placement({ maxHeight: 900 }), 301, 1))).toBe(false);
    expect(sameFit(null, a)).toBe(false);
  });

  it('turns logical bounds into physical bounds that round up, never clipping', () => {
    const bounds = { x: 100.4, y: 200.6, w: 300.2, h: 450.7 };
    expect(physicalPanelBounds(bounds, 1)).toEqual({ x: 100, y: 201, w: 301, h: 451 });
    expect(physicalPanelBounds(bounds, 1.25)).toEqual({ x: 126, y: 251, w: 376, h: 564 });
    expect(physicalPanelBounds(bounds, 2)).toEqual({ x: 201, y: 401, w: 601, h: 902 });
    for (const sf of [1, 1.25, 1.5, 2]) {
      const p = physicalPanelBounds(bounds, sf);
      expect(p.w).toBeGreaterThanOrEqual(bounds.w * sf);
      expect(p.h).toBeGreaterThanOrEqual(bounds.h * sf);
    }
  });

  it('never dedupes a DPI-only change away', () => {
    // Same logical geometry, different monitor scale factor: the native window must move.
    const bounds = { x: 100.4, y: 200.6, w: 300.2, h: 450.7 };
    const at1 = physicalPanelBounds(bounds, 1);
    const at125 = physicalPanelBounds(bounds, 1.25);
    const at2 = physicalPanelBounds(bounds, 2);
    expect(samePhysical(at1, at125)).toBe(false);
    expect(samePhysical(at125, at2)).toBe(false);
    expect(samePhysical(at1, physicalPanelBounds(bounds, 1))).toBe(true);
    expect(samePhysical(null, at1)).toBe(false);
  });
});

describe('independent detail window', () => {
  it.each(['top', 'bottom', 'left', 'right'] as Edge[])(
    'fits the natural and scaled panel inside the monitor on %s without changing the strip',
    (edge) => {
      const vertical = edge === 'left' || edge === 'right';
      for (const offset of [0, 0.5, 1]) {
        const strip = stripRect(area, edge, offset, vertical ? 80 : 400, vertical ? 400 : 80);
        const original = { ...strip };
        const anchor = vertical ? strip.y + 40 : strip.x + 40;
        for (const layoutHeight of [120, 320, 5000]) {
          const p: DetailPlacement = { area, strip, edge, anchor, width: 300, maxHeight: panelHeightLimit(area, edge, strip) };
          const fit = fitPanel(p, layoutHeight, 1);
          const rect = detailBounds(p, fit);
          expect(contains(area, rect.x, rect.y)).toBe(true);
          expect(rect.x + rect.w).toBeLessThanOrEqual(area.x + area.w + 1e-9);
          expect(rect.y + rect.h).toBeLessThanOrEqual(area.y + area.h + 1e-9);
          // Scaling never widens the panel beyond its baseline width.
          expect(rect.w).toBeLessThanOrEqual(p.width + 1e-9);
          expect(fit.height).toBeLessThanOrEqual(p.maxHeight);
          expect(strip).toEqual(original);
        }
      }
    },
  );

  it.each(['top', 'bottom', 'left', 'right'] as Edge[])('keeps fractional DPI geometry from clipping on %s', (edge) => {
    const vertical = edge === 'left' || edge === 'right';
    const strip = stripRect(area, edge, 0.5, vertical ? 80 : 400, vertical ? 400 : 80);
    const p: DetailPlacement = {
      area,
      strip,
      edge,
      anchor: (vertical ? strip.y : strip.x) + 37.5,
      width: 333,
      maxHeight: panelHeightLimit(area, edge, strip),
    };
    const fit = fitPanel(p, 1401.5, 1);
    expect(fit.scaled).toBe(true);
    const rect = detailBounds(p, fit);
    for (const sf of [1, 1.25, 1.5, 2]) {
      // Physical size rounds up, so the native window never clips the rendered logical box.
      expect(Math.ceil(fit.width * sf) / sf).toBeGreaterThanOrEqual(fit.width);
      expect(Math.ceil(fit.height * sf) / sf).toBeGreaterThanOrEqual(fit.height);
      expect(rect.x + rect.w).toBeLessThanOrEqual(area.x + area.w + 1e-9);
      expect(rect.y + rect.h).toBeLessThanOrEqual(area.y + area.h + 1e-9);
    }
    expect(fit.height).toBeLessThanOrEqual(p.maxHeight);
    expect(rect.w).toBeLessThanOrEqual(p.width + 1e-9);
  });

  it('ignores late enter/leave/actions from a closed or replaced provider session', () => {
    const state = { revision: 42, report: { id: 'claude' as const } };
    for (const kind of ['enter', 'leave', 'hide'] as const) {
      expect(isCurrentDetailInteraction(null, { revision: 42, provider: 'claude', kind })).toBe(false);
      expect(isCurrentDetailInteraction(state, { revision: 41, provider: 'claude', kind })).toBe(false);
      expect(isCurrentDetailInteraction(state, { revision: 42, provider: 'codex', kind })).toBe(false);
      expect(isCurrentDetailInteraction(state, { revision: 42, provider: 'claude', kind })).toBe(true);
    }
  });

  it('serializes work and skips superseded pending layouts', async () => {
    const queue = createLatestQueue();
    const calls: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = queue(async (current: () => boolean) => {
      calls.push('first:start');
      await blocked;
      if (current()) calls.push('first:show');
    });
    // Allow the first job to start before replacing it.
    await Promise.resolve();
    const stale = queue(async () => { calls.push('stale'); });
    const latest = queue(async () => { calls.push('latest'); });
    release();
    await Promise.all([first, stale, latest]);
    expect(calls).toEqual(['first:start', 'latest']);
  });

  it('invalidates an opening layout before hiding and recovers after errors', async () => {
    const queue = createLatestQueue();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let shown = false;
    const opening = queue(async (current: () => boolean) => {
      await blocked;
      if (current()) shown = true;
    });
    await Promise.resolve();
    const hide = queue(async () => { shown = false; });
    release();
    await Promise.all([opening, hide]);
    expect(shown).toBe(false);
    await expect(queue(async () => { throw new Error('native failure'); })).rejects.toThrow('native failure');
    await queue(async () => { shown = true; });
    expect(shown).toBe(true);
  });
});
