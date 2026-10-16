import { panelRect, type Edge, type Rect } from './dock';
import type { UsageReport } from './types';

export const DETAIL_WINDOW = 'detail';
export const DETAIL_EVENTS = {
  state: 'detail-state',
  ready: 'detail-ready',
  requestReady: 'detail-request-ready',
  interaction: 'detail-interaction',
  widgetHidden: 'widget-hidden',
  dismiss: 'detail-dismiss',
} as const;

export const ORB_BASE = 56;
export const PANEL_ZOOM_MIN = 0.6;
export const PANEL_ZOOM_MAX = 1.5;

/**
 * Basal panel scale for a circle size: the panel is designed around a 56 px orb
 * and scales with it, clamped like the strip so the native window stays sane.
 */
export function basePanelZoom(orbSize: number): number {
  return Math.max(PANEL_ZOOM_MIN, Math.min(PANEL_ZOOM_MAX, orbSize / ORB_BASE));
}

export interface DetailPlacement {
  area: Rect;
  strip: Rect;
  edge: Edge;
  anchor: number;
  /** Logical width the panel renders at basal zoom. */
  width: number;
  /** Logical height the panel may occupy inside the work area. */
  maxHeight: number;
}

/** Only display data crosses into the detail webview, never provider configuration or secrets. */
export interface DetailState extends DetailPlacement {
  revision: number;
  report: UsageReport;
  scaleFactor: number;
  orbSize: number;
  opacity: number;
  colors: [string, string, string];
  updatedAt: number | null;
  refreshMinutes: number;
  error: string | null;
  /** URL de uso ya resuelta (p. ej. el dashboard de 9Router con su Base URL). */
  usageUrl: string | undefined;
}

export interface DetailInteraction {
  revision: number;
  provider: string;
  kind: 'enter' | 'leave' | 'hide';
}

export function isCurrentDetailInteraction(
  state: { revision: number; report: Pick<UsageReport, 'id'> } | null,
  event: DetailInteraction,
): boolean {
  return !!state && state.revision === event.revision && state.report.id === event.provider;
}

export interface PanelFit {
  /** Scale applied to the panel: basal zoom × fit factor. Never enlarges content. */
  zoom: number;
  /** Rendered logical width after proportional scaling. */
  width: number;
  /** Rendered logical height; never above `maxHeight`. */
  height: number;
  /** Whether the content had to be scaled down to fit the work area. */
  scaled: boolean;
}

/**
 * Fits the panel's natural content into the available work area.
 *
 * `layoutHeight` is the panel's unscaled CSS height (transforms do not reflow, so
 * this is stable regardless of the scale currently applied). The natural logical
 * height is that value at basal zoom. When it exceeds `maxHeight` the whole panel
 * is scaled down proportionally; otherwise it keeps its basal zoom and natural
 * height. Returning `maxHeight` verbatim when scaling avoids the ceil() phantom
 * pixel that a 600.000061 rendered box would otherwise produce.
 */
export function fitPanel(placement: DetailPlacement, layoutHeight: number, base: number): PanelFit {
  const natural = Math.max(1, layoutHeight) * base;
  const factor = natural > placement.maxHeight ? placement.maxHeight / natural : 1;
  return {
    zoom: base * factor,
    width: placement.width * factor,
    height: factor < 1 ? Math.max(1, placement.maxHeight) : Math.max(1, Math.ceil(natural)),
    scaled: factor < 1,
  };
}

/** Logical bounds of the fitted panel next to its strip. */
export function detailBounds(placement: DetailPlacement, fit: PanelFit): Rect {
  return panelRect(placement.area, placement.edge, placement.strip, placement.anchor, Math.max(1, fit.width), Math.max(1, fit.height));
}

/** True when two fits are the same up to floating error, to skip redundant native resizes. */
export function sameFit(a: PanelFit | null, b: PanelFit): boolean {
  return !!a && Math.abs(a.zoom - b.zoom) < 1e-6 && Math.abs(a.width - b.width) < 1e-6 && Math.abs(a.height - b.height) < 1e-6 && a.scaled === b.scaled;
}

/** Native window geometry in physical pixels, rounded so the rendered box never clips. */
export interface PhysicalBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Logical panel bounds turned into native physical bounds for a monitor scale factor. */
export function physicalPanelBounds(bounds: Rect, scaleFactor: number): PhysicalBounds {
  return {
    x: Math.round(bounds.x * scaleFactor),
    y: Math.round(bounds.y * scaleFactor),
    w: Math.max(1, Math.ceil(bounds.w * scaleFactor)),
    h: Math.max(1, Math.ceil(bounds.h * scaleFactor)),
  };
}

/** True when two physical bounds are identical, so a DPI-only change is never deduped away. */
export function samePhysical(a: PhysicalBounds | null, b: PhysicalBounds): boolean {
  return !!a && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * Scale currently painted on the panel, read from its inline `transform` so it always
 * matches the DOM. Reads during render can drift under concurrent React, so the live
 * scale is only ever recovered from the committed style here.
 */
export function panelScaleFromTransform(transform: string): number {
  const match = /scale\(([^)]+)\)/.exec(transform);
  const value = match ? Number.parseFloat(match[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Serializes native mutations; pending stale jobs are skipped and active jobs can check after every await. */
export function createLatestQueue() {
  let revision = 0;
  let tail: Promise<void> = Promise.resolve();
  return (job: (isCurrent: () => boolean) => Promise<void>): Promise<void> => {
    const own = ++revision;
    const current = () => own === revision;
    const result = tail.then(async () => {
      if (current()) await job(current);
    });
    tail = result.catch(() => {});
    return result;
  };
}
