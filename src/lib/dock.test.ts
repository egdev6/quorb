import { describe, expect, it } from 'vitest';
import { nearestEdge, panelHeightLimit, panelRect, panelWindowRect, stripRect, union } from './dock';
import { toMonitor } from './text-scale';

const area = { x: 0, y: 0, w: 1920, h: 1040 }; // pantalla menos barra de tareas

describe('dock', () => {
  it('finds the nearest edge and offset', () => {
    expect(nearestEdge(area, 960, 20)).toEqual({ edge: 'top', offset: 0.5 });
    expect(nearestEdge(area, 1900, 520)).toEqual({ edge: 'right', offset: 0.5 });
    expect(nearestEdge(area, 10, 260).edge).toBe('left');
    expect(nearestEdge(area, 480, 1030)).toEqual({ edge: 'bottom', offset: 0.25 });
  });

  it('keeps the strip flush and inside the screen', () => {
    expect(stripRect(area, 'top', 0.5, 400, 80)).toEqual({ x: 760, y: 0, w: 400, h: 80 });
    expect(stripRect(area, 'bottom', 0, 400, 80)).toEqual({ x: 0, y: 960, w: 400, h: 80 });
    expect(stripRect(area, 'right', 1, 80, 400)).toEqual({ x: 1840, y: 640, w: 80, h: 400 });
  });

  // Text scale (#228): the CSS strip size enters in monitor units and keeps the anchored edge exact.
  it.each([[1.0812, 1.02], [1.25, 1], [1.5, 1.25], [2.25, 1.5]])('keeps the right and bottom edges with text scale %s on monitor scale %s', (t, sf) => {
    const monitor = { x: -1920 / sf, y: 0, w: 1920 / sf, h: 1040 / sf };
    for (const offset of [0, 0.5, 1]) {
      const right = stripRect(monitor, 'right', offset, toMonitor(64, t), toMonitor(320, t));
      expect(right.x + right.w).toBe(monitor.x + monitor.w);
      expect([right.w, right.h]).toEqual([64 * t, 320 * t]);
      const bottom = stripRect(monitor, 'bottom', offset, toMonitor(400, t), toMonitor(80, t));
      expect(bottom.y + bottom.h).toBe(monitor.y + monitor.h);
      expect([bottom.w, bottom.h]).toEqual([400 * t, 80 * t]);
    }
  });

  it('opens the panel towards the inside, clamped', () => {
    const top = stripRect(area, 'top', 0.5, 400, 80);
    expect(panelRect(area, 'top', top, 800, 300, 200)).toEqual({ x: 650, y: 88, w: 300, h: 200 });
    const right = stripRect(area, 'right', 0.02, 80, 400);
    const p = panelRect(area, 'right', right, 30, 300, 260);
    expect(p).toEqual({ x: 1532, y: 0, w: 300, h: 260 });
    const left = stripRect(area, 'left', 0.5, 80, 400);
    expect(panelRect(area, 'left', left, 520, 300, 200).x).toBe(88);
  });

  it.each(['top', 'bottom', 'left', 'right'] as const)('keeps window bounds stable between circles on %s', (edge) => {
    const vertical = edge === 'left' || edge === 'right';
    const strip = stripRect(area, edge, 0.5, vertical ? 80 : 400, vertical ? 400 : 80);
    const start = vertical ? strip.y : strip.x;
    const end = start + (vertical ? strip.h : strip.w);
    const bounds = panelWindowRect(area, edge, strip, 300, 200);
    for (const anchor of [start, (start + end) / 2, end]) {
      const panel = panelRect(area, edge, strip, anchor, 300, 200);
      expect(union(bounds, panel)).toEqual(bounds);
    }
    expect(bounds.x).toBeGreaterThanOrEqual(area.x);
    expect(bounds.y).toBeGreaterThanOrEqual(area.y);
    expect(bounds.x + bounds.w).toBeLessThanOrEqual(area.x + area.w);
    expect(bounds.y + bounds.h).toBeLessThanOrEqual(area.y + area.h);
  });

  it('keeps the top strip offset fixed as panel height and hovered circle change', () => {
    const strip = stripRect(area, 'top', 0.5, 400, 80);
    const firstPanel = panelRect(area, 'top', strip, strip.x + 24, 300, 160);
    const lastPanel = panelRect(area, 'top', strip, strip.x + strip.w - 24, 300, 360);
    // The old tight union changed the native origin at the first circle.
    expect(union(strip, firstPanel).x).not.toBe(union(strip, lastPanel).x);
    const small = panelWindowRect(area, 'top', strip, 300, 160);
    const tall = panelWindowRect(area, 'top', strip, 300, 360);
    expect({ x: small.x, y: small.y, w: small.w }).toEqual({ x: tall.x, y: tall.y, w: tall.w });
  });

  it.each(['top', 'bottom', 'left', 'right'] as const)('reserves every provider height without moving the strip on %s', (edge) => {
    for (const offset of [0, 0.5, 1]) {
      const vertical = edge === 'left' || edge === 'right';
      const monitor = { x: -1920, y: -200, w: 1920, h: 720 };
      const strip = stripRect(monitor, edge, offset, vertical ? 80 : 400, vertical ? 400 : 80);
      const limit = panelHeightLimit(monitor, edge, strip);
      const reserved = panelWindowRect(monitor, edge, strip, 300, limit);
      const start = vertical ? strip.y : strip.x;
      const length = vertical ? strip.h : strip.w;
      for (const h of [120, 260, limit]) {
        for (const anchor of [start + 24, start + length - 24]) {
          const panel = panelRect(monitor, edge, strip, anchor, 300, Math.min(h, limit));
          expect(union(reserved, panel)).toEqual(reserved);
        }
      }
      expect(reserved.y).toBeGreaterThanOrEqual(monitor.y);
      expect(reserved.y + reserved.h).toBeLessThanOrEqual(monitor.y + monitor.h);
    }
  });

  it('limits panel height to the available space on short monitors', () => {
    const short = { x: 0, y: 0, w: 800, h: 300 };
    const strip = stripRect(short, 'bottom', 0.5, 400, 80);
    expect(panelHeightLimit(short, 'bottom', strip)).toBe(212);
    expect(panelHeightLimit(short, 'left', strip)).toBe(300);
    expect(panelHeightLimit(area, 'top', strip)).toBe(952);
  });

  it('reserves the full height even for a narrow panel (no width cap)', () => {
    const tall = { x: 0, y: 0, w: 400, h: 1400 };
    const strip = stripRect(tall, 'top', 0.5, 400, 80);
    // The old model capped a 300 px panel at 480 px; the natural height now wins.
    expect(panelHeightLimit(tall, 'top', strip)).toBe(1400 - 80 - 8);
    expect(panelHeightLimit(tall, 'left', strip)).toBe(1400);
  });

  it('unions rects', () => {
    expect(union({ x: 10, y: 10, w: 10, h: 10 }, { x: 0, y: 15, w: 5, h: 20 })).toEqual({ x: 0, y: 10, w: 20, h: 25 });
  });
});
