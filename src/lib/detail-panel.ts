import { panelRect, type Edge, type Rect } from './dock';
import type { UsageReport } from './types';

/** Preserve the current orb scaling/clamps, then add 50 logical pixels. */
export const panelWidthFor = (orb: number) => Math.round(Math.min(460, Math.max(220, (330 * orb) / 60))) + 50;

export const DETAIL_WINDOW = 'detail';
export const DETAIL_EVENTS = {
  state: 'detail-state',
  ready: 'detail-ready',
  requestReady: 'detail-request-ready',
  interaction: 'detail-interaction',
  widgetHidden: 'widget-hidden',
  dismiss: 'detail-dismiss',
  escape: 'detail-escape',
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
  /**
   * - `enter`/`leave`: el puntero entró o salió del panel de detalle.
   * - `hide`: el detalle pidió ser ocultado (el proveedor se marca como oculto).
   * - `placement-failed`: un **hecho declarado**, no una orden: el detalle no
   *   pudo colocarse (#250/S22). La tira decide qué hacer con él (hoy, lo
   *   cierra como en un cierre normal); el detalle no manda sobre la tira.
   */
  kind: 'enter' | 'leave' | 'hide' | 'placement-failed';
}

export function isCurrentDetailInteraction(state: { revision: number; report: Pick<UsageReport, 'id'> } | null, event: DetailInteraction): boolean {
  return !!state && state.revision === event.revision && state.report.id === event.provider;
}

export interface PanelFit {
  /** Scale applied to the panel: basal zoom × fit factor. Never enlarges content. */
  zoom: number;
  /** Rendered logical width after proportional scaling. */
  width: number;
  /** Rendered logical height, ceiled except at an active height limit. */
  height: number;
  /** Whether the content had to be scaled down to fit the work area. */
  scaled: boolean;
}

/**
 * Fits the panel's natural content into the available work area.
 *
 * `layoutHeight` is the panel's unscaled CSS height (transforms do not reflow, so
 * this is stable regardless of the scale currently applied). The natural height,
 * in monitor units, is that value at basal zoom times `scale`, the text scale of
 * the detail window (#228). Width already includes basal zoom. The smaller of
 * the width and height factors uniformly shrinks the content, never enlarging it.
 * Zoom is a CSS transform and never carries the text scale; sizes are monitor
 * units. Return maxHeight verbatim only when height is active (including ties),
 * avoiding a ceil() phantom pixel; otherwise ceil the scaled natural height.
 */
export function fitPanel(placement: DetailPlacement, layoutHeight: number, base: number, scale = 1): PanelFit {
  return fitWithin(placement, layoutHeight, base, scale, panelWidthLimit(placement), placement.maxHeight);
}

/** Space inward of the actual strip, not an assumed flush strip of the same size. */
function panelWidthLimit({ area, strip, edge }: DetailPlacement): number {
  const available = edge === 'left' ? area.x + area.w - strip.x - strip.w - 8 : edge === 'right' ? strip.x - 8 - area.x : area.w;
  return Math.max(1, available);
}

function fitWithin(placement: DetailPlacement, layoutHeight: number, base: number, scale: number, maxWidth: number, maxHeight: number): PanelFit {
  const natural = Math.max(1, layoutHeight) * base * scale;
  const heightLimit = Math.max(1, maxHeight);
  const heightFactor = heightLimit / natural;
  const factor = Math.min(1, heightFactor, Math.max(1, maxWidth) / (placement.width * scale));
  return {
    zoom: base * factor,
    width: placement.width * scale * factor,
    height: heightFactor === factor ? heightLimit : Math.max(1, Math.ceil(natural * factor)),
    scaled: factor < 1,
  };
}

/**
 * Fit and place only the detail in the integer physical space inward of its strip.
 * Widget.geoOf divides integer work-area position/size by sf; round those values
 * back separately (do not ceil the logical area's size like a rendered surface).
 * Inward strip boundaries round into the free space, retaining at least gap 8.
 *
 * Usually only the rounded origin needs clamping. If ceil(size × sf) will not fit,
 * refit the content uniformly before converting again, never truncate the native
 * surface under a larger DOM transform. A tiny physical inset absorbs float error
 * at integer size boundaries. If logical ceil(height) still exceeds the physical
 * budget, use its whole-logical-pixel height limit and refit by the same rules.
 * Full containment requires usable width/height >= ceil(sf), since detailBounds
 * pads each dimension to at least one logical pixel. Impossible areas retain that
 * minimum and still use the normal native placement/retry path, not a new failure.
 */
export function fitDetailPanel(
  placement: DetailPlacement,
  layoutHeight: number,
  base: number,
  scale: number,
  sf: number,
): { fit: PanelFit; physical: PhysicalBounds } {
  const { area, strip, edge } = placement;
  let left = Math.round(area.x * sf);
  let top = Math.round(area.y * sf);
  let right = left + Math.round(area.w * sf);
  let bottom = top + Math.round(area.h * sf);
  if (edge === 'left') left = Math.max(left, Math.ceil((strip.x + strip.w + 8) * sf));
  if (edge === 'right') right = Math.min(right, Math.floor((strip.x - 8) * sf));
  if (edge === 'top') top = Math.max(top, Math.ceil((strip.y + strip.h + 8) * sf));
  if (edge === 'bottom') bottom = Math.min(bottom, Math.floor((strip.y - 8) * sf));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  let fit = fitPanel(placement, layoutHeight, base, scale);
  const physicalOf = (value: PanelFit) => {
    const bounds = detailBounds(placement, value);
    // Use the DOM's operation order too: algebraically equal products can differ
    // by an ulp, and ceil must cover the painted size rather than clip that ulp.
    bounds.w = Math.max(bounds.w, (placement.width / base) * value.zoom * scale);
    bounds.h = Math.max(bounds.h, Math.max(1, layoutHeight) * value.zoom * scale);
    return physicalPanelBounds(bounds, sf);
  };
  let physical = physicalOf(fit);
  if (physical.w > width || physical.h > height) {
    const maxWidth = Math.min(panelWidthLimit(placement), (width - 1e-9) / sf);
    const maxHeight = Math.min(placement.maxHeight, (height - 1e-9) / sf);
    fit = fitWithin(placement, layoutHeight, base, scale, maxWidth, maxHeight);
    physical = physicalOf(fit);
    if (physical.h > height) {
      fit = fitWithin(placement, layoutHeight, base, scale, maxWidth, Math.floor(maxHeight));
      physical = physicalOf(fit);
    }
  }
  physical.x = Math.max(left, Math.min(physical.x, right - physical.w));
  physical.y = Math.max(top, Math.min(physical.y, bottom - physical.h));
  return { fit, physical };
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
