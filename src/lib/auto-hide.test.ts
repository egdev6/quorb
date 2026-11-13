import widget from '../Widget.tsx?raw';
import { Widget } from '../Widget';
import { createElement, isValidElement, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import hook from './useDockReveal.ts?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finishReveal, peekRect, readyReveal, requestReveal, usesPeekWindow, waitForViewport, watchPreparation, REVEAL_DURATION, type RevealPhase } from './auto-hide';
import { resetDragMode, setDragMode } from './drag-session';
import { contains, nearestEdge, panelHeightLimit, stripRect, type Edge } from './dock';
import { DETAIL_EVENTS, physicalPanelBounds } from './detail-panel';
import { POINTER_SURFACE_EVENT } from './hover-presence';
import { NO_PANEL, type PanelState } from './anchor-panel';
import type { UsageReport } from './types';

type GripHandlers = {
  onPointerDown(event: ReactPointerEvent<HTMLSpanElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLSpanElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLSpanElement>): Promise<void>;
  onPointerCancel(event: ReactPointerEvent<HTMLSpanElement>): Promise<void>;
};

function findGrip(node: ReactNode): GripHandlers | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const grip = findGrip(child);
      if (grip) return grip;
    }
    return;
  }
  if (!isValidElement<{ className?: string; children?: ReactNode }>(node)) return;
  if (node.props.className === 'strip__grip') return node.props as unknown as GripHandlers;
  return findGrip(node.props.children);
}

/** The hover handler of the first orb of the strip (real props of the tree). */
function findOrbHover(node: ReactNode): ((el: HTMLElement) => void) | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hover = findOrbHover(child);
      if (hover) return hover;
    }
    return;
  }
  if (!isValidElement<{ onPointerEnter?: (el: HTMLElement) => void; children?: ReactNode }>(node)) return;
  if (node.props.onPointerEnter) return node.props.onPointerEnter;
  return findOrbHover(node.props.children);
}

type DockHandlers = {
  onMouseEnter(): void;
  onMouseLeave(): void;
};

type OrbPointer = {
  id: string;
  onPointerDown(event: unknown): void;
  onPointerMove(event: unknown): void;
  onPointerUp(event: unknown): void;
};

/** The reorder handlers of every orb of the strip (real props of the tree). */
function findOrbPointers(node: ReactNode, out: OrbPointer[] = []): OrbPointer[] {
  if (Array.isArray(node)) {
    for (const child of node) findOrbPointers(child, out);
    return out;
  }
  if (!isValidElement<{ report?: { id: string }; pointer?: Omit<OrbPointer, 'id'>; children?: ReactNode }>(node)) return out;
  if (node.props.pointer && node.props.report) out.push({ id: node.props.report.id, ...node.props.pointer });
  return findOrbPointers(node.props.children, out);
}

/** The strip's own pointer handlers, taken from the rendered tree. */
function findDock(node: ReactNode): DockHandlers | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const dock = findDock(child);
      if (dock) return dock;
    }
    return;
  }
  if (!isValidElement<{ className?: string; children?: ReactNode }>(node)) return;
  if (node.props.className === 'dock') return node.props as unknown as DockHandlers;
  return findDock(node.props.children);
}

// Capture the real Widget effect callbacks while SSR supplies its hook scope.
// No DOM renderer, Tauri runtime, or native-order assumptions are involved.
const widgetEffects = vi.hoisted(() => ({
  states: [] as unknown[], stateIndex: 0,
  refs: [] as { current: unknown }[], refIndex: 0,
  effects: [] as { run: () => void | (() => void); deps?: readonly unknown[] }[],
  bounds: vi.fn(), clip: vi.fn(), show: vi.fn(), innerSize: vi.fn(),
  outerPosition: vi.fn(), setPosition: vi.fn(), monitors: vi.fn(), patch: vi.fn(), stateWrite: vi.fn(),
  cancel: vi.fn(async () => {}),
  listeners: new Map<string, ((event?: { payload?: unknown }) => void)[]>(),
  // Hook results isolated from the useState slots: text scale (#228) and reveal phase.
  textScale: undefined as number | undefined,
  phase: undefined as RevealPhase | undefined,
}));
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal() as typeof import('react');
  return {
    ...react,
    useState: ((initial?: unknown) => {
      const index = widgetEffects.stateIndex++;
      const value = index in widgetEffects.states ? widgetEffects.states[index]
        : typeof initial === 'function' ? initial() : initial;
      // Commit state explicitly in tests, but preserve the actual updater result.
      return [value, vi.fn((next: unknown) => {
        widgetEffects.stateWrite(index, next);
        const previous = index in widgetEffects.states ? widgetEffects.states[index] : value;
        widgetEffects.states[index] = typeof next === 'function' ? next(previous) : next;
      })];
    }) as typeof react.useState,
    useRef: ((initial: unknown) => {
      const index = widgetEffects.refIndex++;
      return widgetEffects.refs[index] ??= { current: initial };
    }) as typeof react.useRef,
    useEffect: ((run, deps) => { widgetEffects.effects.push({ run, deps }); }) as typeof react.useEffect,
    useLayoutEffect: (() => {}) as typeof react.useLayoutEffect,
  };
});
vi.mock('./useDockReveal', () => ({
  useDockReveal: () => ({ phase: widgetEffects.phase ?? 'open', markPrepared: vi.fn(), finishTransition: vi.fn() }),
}));
vi.mock('./useTextScale', () => ({ useTextScale: () => widgetEffects.textScale ?? 1 }));
vi.mock('./useUpdater', () => ({ useUpdaterMode: () => 'unknown' }));
// #180 (WU2): the widget gates drag gestures behind the startup display
// decision; these tests exercise the native (X11) pipeline, so resolve the
// detection seam deterministically instead of letting it hang unresolved.
vi.mock('./wm-detect', () => ({
  detectWindowManager: vi.fn(async () => ({ displayBackend: 'x11' })),
}));
vi.mock('./api', () => ({ api: {
  setWidgetBounds: widgetEffects.bounds,
  setSurfaceClip: widgetEffects.clip,
  patchConfig: widgetEffects.patch,
  cancelWidgetPlacement: widgetEffects.cancel,
} }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    show: widgetEffects.show, innerSize: widgetEffects.innerSize,
    outerPosition: widgetEffects.outerPosition, setPosition: widgetEffects.setPosition,
  }),
  availableMonitors: widgetEffects.monitors,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event?: { payload?: unknown }) => void) => {
    const list = widgetEffects.listeners.get(name) ?? [];
    list.push(handler);
    widgetEffects.listeners.set(name, list);
    return () => {};
  }),
  emitTo: vi.fn(),
}));

describe('auto-hide geometry and phases', () => {
  it.each(['top', 'bottom', 'left', 'right'] as Edge[])('keeps only a centered semicircle inside the strip on %s', (edge) => {
    const vertical = edge === 'left' || edge === 'right';
    const area = { x: -1920, y: -100, w: 1920, h: 1080 };
    for (const offset of [0, 0.5, 1]) {
      const strip = stripRect(area, edge, offset, vertical ? 64 : 320, vertical ? 320 : 64);
      const peek = peekRect(strip, edge);
      expect([peek.w, peek.h]).toEqual(vertical ? [24, 48] : [48, 24]);
      expect(contains(area, peek.x, peek.y)).toBe(true);
      expect(peek.x + peek.w).toBeLessThanOrEqual(area.x + area.w);
      expect(peek.y + peek.h).toBeLessThanOrEqual(area.y + area.h);
      if (vertical) expect(peek.y + peek.h / 2).toBe(strip.y + strip.h / 2);
      else expect(peek.x + peek.w / 2).toBe(strip.x + strip.w / 2);
      if (edge === 'top') expect(peek.y).toBe(strip.y);
      if (edge === 'bottom') expect(peek.y + peek.h).toBe(strip.y + strip.h);
      if (edge === 'left') expect(peek.x).toBe(strip.x);
      if (edge === 'right') expect(peek.x + peek.w).toBe(strip.x + strip.w);
    }
  });

  // The `.peek` handle is 48×24 CSS px: in monitor units it grows with the text scale (#228).
  it.each([1.06, 1.25, 2.25])('scales the handle with text scale %s, centred and inside the area', (scale) => {
    const area = { x: -1920, y: -100, w: 1920, h: 1080 };
    for (const edge of ['top', 'bottom', 'left', 'right'] as Edge[]) {
      const vertical = edge === 'left' || edge === 'right';
      for (const offset of [0, 0.5, 1]) {
        const strip = stripRect(area, edge, offset, (vertical ? 64 : 320) * scale, (vertical ? 320 : 64) * scale);
        const peek = peekRect(strip, edge, scale);
        expect([peek.w, peek.h]).toEqual(vertical ? [24 * scale, 48 * scale] : [48 * scale, 24 * scale]);
        expect(contains(area, peek.x, peek.y)).toBe(true);
        expect(peek.x + peek.w).toBeLessThanOrEqual(area.x + area.w);
        expect(peek.y + peek.h).toBeLessThanOrEqual(area.y + area.h);
        if (vertical) expect(peek.y + peek.h / 2).toBeCloseTo(strip.y + strip.h / 2, 9);
        else expect(peek.x + peek.w / 2).toBeCloseTo(strip.x + strip.w / 2, 9);
        if (edge === 'top') expect(peek.y).toBe(strip.y);
        if (edge === 'bottom') expect(peek.y + peek.h).toBe(strip.y + strip.h);
        if (edge === 'left') expect(peek.x).toBe(strip.x);
        if (edge === 'right') expect(peek.x + peek.w).toBe(strip.x + strip.w);
      }
    }
  });

  it('keeps the CSS handle size without a text scale', () => {
    const strip = stripRect({ x: 0, y: 0, w: 1920, h: 1080 }, 'top', 0.5, 320, 64);
    expect(peekRect(strip, 'top')).toEqual(peekRect(strip, 'top', 1));
    expect(peekRect(strip, 'top')).toEqual({ x: 936, y: 0, w: 48, h: 24 });
  });

  it('keeps the full window until exit finishes and waits for native expansion before entry', () => {
    expect(REVEAL_DURATION).toBe(280);
    const closing = requestReveal('open', true);
    expect(closing).toBe('closing');
    const settling = finishReveal(closing);
    expect(settling).toBe('settling');
    expect(readyReveal(settling)).toBe('hidden');
    const leaving = requestReveal('hidden', false);
    expect(leaving).toBe('leaving-handle');
    const preparing = finishReveal(leaving);
    expect(preparing).toBe('preparing');
    expect(finishReveal(preparing)).toBe('preparing');
    expect(readyReveal(preparing)).toBe('opening');
    expect(finishReveal('opening')).toBe('open');
  });

  it('reverses quickly and rejects late native completions for a cancelled reveal', () => {
    expect(requestReveal('closing', false)).toBe('opening');
    expect(requestReveal('opening', true)).toBe('closing');
    expect(requestReveal('preparing', true)).toBe('settling');
    expect(readyReveal('hidden')).toBe('hidden');
    expect(readyReveal('closing')).toBe('closing');
    expect(requestReveal('open', false)).toBe('open');
    expect(requestReveal('hidden', true)).toBe('hidden');
  });
});

describe('viewport handoff', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  function clock() {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
      requestAnimationFrame: (cb: FrameRequestCallback) => { frames.set(++next, cb); return next; },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    });
    return { frames, frame: () => { const batch = [...frames.values()]; frames.clear(); for (const cb of batch) cb(0); } };
  }

  it.each(['preparing', 'settling'] as RevealPhase[])('reports stalled %s once without advancing its phase or invoking a native retry', async (phase) => {
    clock();
    const stalled = vi.fn();
    const cancel = watchPreparation(phase, stalled);
    await vi.advanceTimersByTimeAsync(1499);
    expect(stalled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stalled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(stalled).toHaveBeenCalledTimes(1);
    cancel();
  });

  it('cancels preparation feedback on completion and never watches an open strip', async () => {
    clock();
    const stalled = vi.fn();
    const cancel = watchPreparation('preparing', stalled);
    cancel();
    watchPreparation('open', stalled);
    await vi.advanceTimersByTimeAsync(2000);
    expect(stalled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the compact viewport through the fade and never resizes a painted handle', () => {
    for (const p of ['hidden', 'leaving-handle', 'settling'] as RevealPhase[]) expect(usesPeekWindow(p)).toBe(true);
    for (const p of ['preparing', 'opening', 'open', 'closing'] as RevealPhase[]) expect(usesPeekWindow(p)).toBe(false);
    expect(requestReveal('leaving-handle', true)).toBe('settling');
    expect(requestReveal('settling', false)).toBe('preparing');
    expect(finishReveal('settling')).toBe('settling');
  });

  it('waits for two rendered frames, then cancels the fallback timer', async () => {
    const c = clock();
    let done = false;
    const pending = waitForViewport().then(() => { done = true; });
    c.frame();
    await Promise.resolve();
    expect(done).toBe(false);
    c.frame();
    await pending;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(c.frames.size).toBe(0);
  });

  it('finishes with a bounded fallback when an occluded WebView does not paint', async () => {
    const c = clock();
    const pending = waitForViewport();
    await vi.advanceTimersByTimeAsync(120);
    await pending;
    expect(c.frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('auto-hide reveal integration', () => {
  it('keeps a visible failed handle reachable by keyboard without tabbing into an invisible open handle', () => {
    expect(widget).toContain("placementFailed && (usesPeekWindow(phase) || phase === 'preparing')");
  });
  it('keeps error feedback stable until preparation succeeds and watches stalled preparation', () => {
    const begin = widget.indexOf('widgetQueue(async');
    expect(widget.indexOf('setPlacementFailed(false)', begin)).toBeGreaterThan(widget.indexOf('await waitForViewport()', begin));
    expect(widget).toContain('watchPreparation(phase,');
  });
  it('correlates native completions with the phase that requested them', () => {
    expect(hook).toContain('p === preparedPhase ? readyReveal(p) : p');
    expect(widget).toContain('markPrepared(phase)');
  });
  it('lets the user retry a failed native preparation without an automatic retry loop', () => {
    expect(widget).toContain('setPlacementRetry((n) => n + 1)');
    expect(widget).toContain('placementRetry,');
    expect(widget).toContain('setPlacementFailed(true)');
  });

  it('keeps the handle mounted while disabling auto-hide and until keyboard focus transfers', () => {
    expect(widget).toContain("const showHandle = autoHide || phase !== 'open'");
    expect(widget).toContain("phase === 'open' && !peekFocused");
    expect(widget).not.toContain("aria-hidden={phase === 'open' || phase === 'opening'");
  });

  it('settles on the transform end with a guarded fallback rather than cutting at 240ms', () => {
    expect(widget).toContain('onTransitionEnd=');
    expect(widget).toContain('finishTransition()');
    expect(hook).toContain('REVEAL_FALLBACK');
  });
  it('replaces the thin peek stripe with an accessible button and staged visibility', () => {
    expect(widget).toMatch(/<button\s[^>]*className="peek"/s);
    expect(widget).toContain('data-reveal={phase}');
    expect(widget).not.toContain('const PEEK = 5;');
  });

  it('moves and resizes the widget atomically before revealing the strip', () => {
    expect(widget).toContain('await api.setWidgetBounds(physical)');
    expect(widget).toContain('markPrepared(phase)');
    expect(widget).toContain("phase === 'open'");
    expect(widget).toContain('usesPeekWindow(phase) ? peekRect(s, edge, textScale) : s');
    expect(widget).toContain('await waitForViewport()');
    expect(widget).toContain('data-placement-failed={placementFailed');
    expect(widget).toContain("api.setSurfaceClip(c, !autoHide && phase === 'open')");
    expect(widget).toContain("inert={phase !== 'open'}");
    expect(widget).toContain('inside || focused ||');
  });
});

describe('Widget effect mutation ordering', () => {
  const geo = {
    area: { x: 0, y: 0, w: 1920, h: 1080 }, sf: 1, monitor: null,
    screen: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const commitWidget = () => {
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.effects = [];
    let grip: GripHandlers | undefined;
    function CaptureWidget() {
      const tree = Widget();
      grip = findGrip(tree); // Real handlers from the returned JSX, not copied drag logic.
      return tree;
    }
    renderToStaticMarkup(createElement(CaptureWidget));
    widgetEffects.refs[0].current = { dataset: {} };
    widgetEffects.refs[1].current = { dataset: {} };
    return {
      placement: widgetEffects.effects.find(e => e.deps?.[0] === widgetEffects.states[5])!,
      drag: widgetEffects.effects.find(e => e.deps?.[0] === widgetEffects.states[9]
        && e.deps?.[1] === widgetEffects.states[5])!,
      grip: grip!,
    };
  };
  const renderWidget = (dragging: boolean, autoHide = false, sf = geo.sf) => {
    // Hook slots belong to Widget (useDockReveal/useUpdaterMode are isolated above).
    widgetEffects.states[0] = autoHide ? { autoHide, accounts: [], nineRouter: { baseUrl: '' } } : null;
    widgetEffects.states[5] = sf === geo.sf ? geo : { ...geo, sf };
    widgetEffects.states[6] = { w: 400, h: 80 };
    widgetEffects.states[9] = dragging;
    return commitWidget();
  };
  // Text scale (#228): the strip is measured in CSS px and placed in monitor units.
  const renderScaled = (scale: number, sf: number, phase: RevealPhase = 'open') => {
    widgetEffects.textScale = scale;
    widgetEffects.phase = phase;
    widgetEffects.states[0] = null;
    widgetEffects.states[5] = { ...geo, sf };
    widgetEffects.states[6] = { w: 400, h: 80 };
    widgetEffects.states[9] = false;
    return commitWidget();
  };
  const placeScaled = async (scale: number, sf: number, phase: RevealPhase = 'open') => {
    configureNative();
    const cleanup = renderScaled(scale, sf, phase).placement.run();
    await flush();
    if (typeof cleanup === 'function') cleanup();
    const strip = stripRect(geo.area, 'top', 0.5, 400 * scale, 80 * scale);
    const win = usesPeekWindow(phase) ? peekRect(strip, 'top', scale) : strip;
    return {
      strip, win,
      bounds: widgetEffects.bounds.mock.calls[0]?.[0],
      clip: widgetEffects.clip.mock.calls[0]?.[0],
      pos: widgetEffects.states[10],
    };
  };
  const configureNative = () => {
    widgetEffects.bounds.mockResolvedValue(undefined);
    widgetEffects.clip.mockResolvedValue(undefined);
    widgetEffects.show.mockResolvedValue(undefined);
    widgetEffects.innerSize.mockResolvedValue({ width: 400, height: 80 });
    vi.stubGlobal('getComputedStyle', () => ({
      borderTopLeftRadius: '14px', borderTopRightRadius: '14px',
      borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px',
    }));
    // SSR runs no React effects, so the #180 module decision store never sees
    // the mount-effect write; these tests drive the native branch directly.
    setDragMode('native');
  };

  afterEach(() => {
    widgetEffects.states = [];
    widgetEffects.refs = [];
    widgetEffects.effects = [];
    widgetEffects.textScale = undefined;
    widgetEffects.phase = undefined;
    resetDragMode();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('places the text-scaled strip in monitor units and converts to physical once with the monitor scale', async () => {
    const { strip, bounds, clip, pos } = await placeScaled(1.06, 1.02);
    expect([strip.w, strip.h]).toEqual([400 * 1.06, 80 * 1.06]);
    expect(bounds).toEqual({ ...physicalPanelBounds(strip, 1.02), anchor: 'top', scale: 1.02 });
    expect(pos).toEqual({ strip: { x: 0, y: 0 } });
    // Radii are CSS px: the clip scale is the text scale times the monitor scale, never the live ratio.
    expect(clip).toEqual({ width: bounds.w, height: bounds.h, radii: [14 * (1.06 * 1.02), 14 * (1.06 * 1.02), 0, 0] });
  });

  it('offsets the text-scaled strip inside the peek window in CSS px', async () => {
    const { strip, win, bounds, pos } = await placeScaled(1.06, 1.02, 'hidden');
    expect([win.y, win.w, win.h]).toEqual([0, 48 * 1.06, 24 * 1.06]);
    expect(win.x + win.w / 2).toBeCloseTo(960, 9);
    expect(bounds).toEqual({ ...physicalPanelBounds(win, 1.02), anchor: 'top', scale: 1.02 });
    expect(pos).toEqual({ strip: { x: (strip.x - win.x) / 1.06, y: (strip.y - win.y) / 1.06 } });
    expect((pos as { strip: { x: number } }).strip.x).toBeCloseTo(-(400 - 48) / 2, 9);
  });

  it.each([1, 1.25, 1.5, 2])('places exactly as before without a text scale (monitor scale %s)', async (sf) => {
    const open = await placeScaled(1, sf);
    expect(open.bounds).toEqual({ ...physicalPanelBounds({ x: 760, y: 0, w: 400, h: 80 }, sf), anchor: 'top', scale: sf });
    expect(open.clip.radii).toEqual([14 * sf, 14 * sf, 0, 0]);
    expect(open.pos).toEqual({ strip: { x: 0, y: 0 } });
    vi.resetAllMocks();
    const peek = await placeScaled(1, sf, 'hidden');
    expect(peek.bounds).toEqual({ ...physicalPanelBounds({ x: 936, y: 0, w: 48, h: 24 }, sf), anchor: 'top', scale: sf });
    expect(peek.pos).toEqual({ strip: { x: -176, y: 0 } });
  });

  it.each([[1, 1], [1.06, 1.02], [1.25, 1.5]])('sends the detail the text-scaled strip and orb anchor (text %s, monitor %s)', (scale, sf) => {
    const report = {
      id: 'a', name: 'A', kind: 'subscription', status: 'ok', plan: null, meters: [], spend: null,
      message: null, action: null, fetchedAt: '2026-11-01T00:00:00Z',
    } as unknown as UsageReport;
    widgetEffects.states[1] = [report];
    widgetEffects.states[7] = { providerId: 'a', anchored: true };
    widgetEffects.states[8] = 30; // Orb centre in CSS px from the strip start.
    renderScaled(scale, sf);
    const detail = widgetEffects.effects.find((e) => e.deps?.[0] === report)!;
    detail.run();
    const sent = widgetEffects.refs.find((r) => (r.current as { report?: unknown } | null)?.report === report)!.current;
    const strip = stripRect(geo.area, 'top', 0.5, 400 * scale, 80 * scale);
    expect(sent).toMatchObject({
      strip, anchor: strip.x + 30 * scale, scaleFactor: sf,
      maxHeight: panelHeightLimit(geo.area, 'top', strip),
    });
  });

  it('cancels the pending native placement when the strip starts to be dragged', () => {
    configureNative();
    const { placement } = renderWidget(true); // dragging
    const cleanup = placement.run();
    expect(widgetEffects.cancel).toHaveBeenCalledTimes(1);
    if (typeof cleanup === 'function') cleanup();
  });

  it('asks again for the placement when the backend could not read the window', async () => {
    configureNative();
    // El backend no pudo leer una ventana que todavía no era visible: tras
    // mostrarla, la colocación se pide de nuevo para confirmar la geometría.
    widgetEffects.bounds.mockResolvedValue({ status: 'unverified', bounds: null, reason: 'not_viewable' });
    const cleanup = renderWidget(false).placement.run();
    await flush();
    expect(widgetEffects.bounds).toHaveBeenCalledTimes(2);
    expect(widgetEffects.show).toHaveBeenCalledTimes(1);
    if (typeof cleanup === 'function') cleanup();
  });

  it('never shows a strip the user hid from the tray, nor re-asks its placement', async () => {
    configureNative();
    const { placement } = renderWidget(false);
    // El usuario oculta la tira desde la bandeja: la visibilidad es suya.
    const listener = widgetEffects.effects.find((e) => e.run.toString().includes('widget-hidden'));
    expect(listener).toBeDefined();
    const cleanupListener = listener!.run();
    await flush();
    for (const handler of widgetEffects.listeners.get('widget-hidden') ?? []) handler();
    widgetEffects.bounds.mockResolvedValue({ status: 'unverified', bounds: null, reason: 'not_viewable' });
    const cleanup = placement.run();
    await flush();
    expect(widgetEffects.show).not.toHaveBeenCalled();
    expect(widgetEffects.bounds).toHaveBeenCalledTimes(1);
    if (typeof cleanup === 'function') cleanup();
    if (typeof cleanupListener === 'function') cleanupListener();
  });

  it('never shows a strip the user hid from the tray, not even through the safety net', async () => {
    configureNative();
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    });
    renderWidget(false);
    // El usuario oculta la tira desde la bandeja: la visibilidad es suya.
    const listener = widgetEffects.effects.find((e) => e.run.toString().includes('widget-hidden'));
    const cleanupListener = listener!.run();
    await flush();
    for (const handler of widgetEffects.listeners.get('widget-hidden') ?? []) handler();
    // La red de seguridad (2,5 s) muestra la ventana si el ciclo no llegó a
    // mostrarla: tampoco puede contradecir al usuario.
    const safetyNet = widgetEffects.effects.find((e) => e.deps?.length === 0 && e.run.toString().includes('setTimeout'));
    expect(safetyNet).toBeDefined();
    const cleanup = safetyNet!.run();
    await vi.advanceTimersByTimeAsync(2500);
    expect(widgetEffects.show).not.toHaveBeenCalled();
    if (typeof cleanup === 'function') cleanup();
    if (typeof cleanupListener === 'function') cleanupListener();
  });

  it('shows the strip through the safety net when the user did not hide it', async () => {
    configureNative();
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    });
    renderWidget(false);
    const safetyNet = widgetEffects.effects.find((e) => e.deps?.length === 0 && e.run.toString().includes('setTimeout'));
    const cleanup = safetyNet!.run();
    await vi.advanceTimersByTimeAsync(2500);
    expect(widgetEffects.show).toHaveBeenCalledTimes(1);
    if (typeof cleanup === 'function') cleanup();
  });

  it.each([true, false])('last accepted RAF drains before pointerup snap (delayBeforeDispatch=%s)', async (delayBeforeDispatch) => {
    configureNative();
    let nativePosition = { x: 760, y: 0 }; // Top-docked 400×80 strip on a 1920×1080 monitor.
    let nativeDispatches = 0;
    let releasePosition!: () => void;
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('window', { clearTimeout: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    widgetEffects.outerPosition.mockImplementation(async () => ({ ...nativePosition }));
    widgetEffects.monitors.mockResolvedValue([{
      name: 'display', scaleFactor: 1, position: { x: 0, y: 0 },
      size: { width: 1920, height: 1080 },
    }]);
    widgetEffects.setPosition.mockImplementation((position: { x: number; y: number }) => {
      // Hold the async core command BEFORE native enqueue/ack. Once released,
      // apply and acknowledge together: there is no post-ack FIFO reordering.
      return new Promise<void>(resolve => {
        releasePosition = () => {
          nativeDispatches++;
          nativePosition = { x: position.x, y: position.y };
          resolve();
        };
        if (!delayBeforeDispatch) releasePosition();
      });
    });
    widgetEffects.patch.mockImplementation(async (patch: { dockEdge: Edge; dockOffset: number; dockMonitor: string | null }) => ({
      accounts: [], nineRouter: { baseUrl: '' }, ...patch,
    }));
    widgetEffects.bounds.mockImplementation(async (bounds: { x: number; y: number }) => {
      nativePosition = { x: bounds.x, y: bounds.y };
    });
    const target = {
      setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 16, height: 80 }),
    };
    const pointer = (screenY: number) => ({
      button: 0, pointerId: 7, screenX: 768, screenY,
      currentTarget: target, target: { closest: () => target }, preventDefault: vi.fn(),
    }) as unknown as ReactPointerEvent<HTMLSpanElement>;

    const { grip } = renderWidget(false);
    grip.onPointerDown(pointer(40));
    await flush(); // The down handler has read the original native origin.
    expect(widgetEffects.outerPosition).toHaveBeenCalledTimes(1);
    grip.onPointerMove(pointer(1000));
    expect(frames.size).toBe(1);
    const [id, acceptedFrame] = [...frames.entries()][0];
    frames.delete(id); // It has run: pointerup cannot cancel this accepted RAF.
    acceptedFrame(0);
    await flush(); // Permit a serialized implementation to start the accepted frame too.
    expect(widgetEffects.setPosition).toHaveBeenCalledTimes(1);
    expect(widgetEffects.setPosition.mock.calls[0][0]).toMatchObject({ x: 760, y: 960 });
    expect(nativeDispatches).toBe(delayBeforeDispatch ? 0 : 1);

    const up = grip.onPointerUp(pointer(1000));
    await flush();
    const earlyReads = widgetEffects.outerPosition.mock.calls.length - 1;
    const earlySnaps = widgetEffects.patch.mock.calls.length;
    let snapCommitted = false;
    let cleanupSnap = () => {};
    const commitSnapIfReady = async () => {
      // Model React's post-pointerup commit once config and dragging state change.
      // Use Widget's actual placement effect to apply the resulting native bounds.
      if (!snapCommitted && widgetEffects.states[9] === false && widgetEffects.patch.mock.calls.length > 0) {
        const cleanup = commitWidget().placement.run();
        if (typeof cleanup === 'function') cleanupSnap = cleanup;
        snapCommitted = true;
        await flush();
      }
    };
    try {
      await commitSnapIfReady();
      if (delayBeforeDispatch) releasePosition();
      await up;
      await flush();
      await commitSnapIfReady();
      const canonical = widgetEffects.states[0] as { dockEdge: Edge; dockOffset: number };
      expect({ earlyReads, earlySnaps, edge: canonical.dockEdge, offset: canonical.dockOffset, nativePosition })
        .toEqual({
          earlyReads: delayBeforeDispatch ? 0 : 1,
          earlySnaps: delayBeforeDispatch ? 0 : 1,
          edge: 'bottom', offset: 0.4,
          nativePosition: { x: 568, y: 1000 },
        });
      expect(nativeDispatches).toBe(1);
      expect(widgetEffects.bounds).toHaveBeenCalledTimes(1);
      expect(frames.size).toBe(0);
    } finally {
      cleanupSnap();
    }
  });

  // Text scale and monitor scale of the docked strip, and the grip's CSS offset (#228).
  const dragFixture = (scale = 1, sf = geo.sf, gripLeft = 0) => {
    configureNative();
    widgetEffects.textScale = scale;
    let position = { x: 760, y: 0 };
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('window', { clearTimeout: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    widgetEffects.outerPosition.mockImplementation(async () => ({ ...position }));
    widgetEffects.monitors.mockResolvedValue([{
      name: 'display', scaleFactor: 1, position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 },
    }]);
    widgetEffects.setPosition.mockImplementation(async (next: { x: number; y: number }) => { position = { ...next }; });
    widgetEffects.patch.mockImplementation(async (patch: { dockEdge: Edge; dockOffset: number }) => ({
      accounts: [], nineRouter: { baseUrl: '' }, ...patch,
    }));
    widgetEffects.bounds.mockImplementation(async (bounds: { x: number; y: number }) => {
      position = { x: bounds.x, y: bounds.y };
    });
    const target = {
      setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(),
      getBoundingClientRect: () => ({ left: gripLeft, top: 0, width: 16, height: 80 }),
    };
    const pointer = (screenY: number, pointerId = 7) => ({
      button: 0, pointerId, screenX: 768, screenY, currentTarget: target,
      target: { closest: () => target }, preventDefault: vi.fn(),
    }) as unknown as ReactPointerEvent<HTMLSpanElement>;
    const { grip } = renderWidget(false, false, sf);
    const runFrame = () => {
      const [id, callback] = [...frames.entries()][0];
      frames.delete(id);
      callback(0);
    };
    const acceptFrame = (screenY: number, pointerId = 7) => {
      grip.onPointerMove(pointer(screenY, pointerId));
      runFrame();
    };
    const unmount = widgetEffects.effects.find(e => e.deps?.length === 0 && e.run.toString().includes('cancelTimers'))!.run();
    return {
      grip, pointer, acceptFrame, runFrame, frames, position: () => position, unmount,
      applyPosition: (next: { x: number; y: number }) => { position = { x: next.x, y: next.y }; },
    };
  };

  // PointerEvent.screenX is CSS px on Windows (#228, L7): physical = Δcss × sf × t.
  it.each([[1.06, 1], [1.2, 1.25]])('moves the window by the CSS pointer delta times text scale %s and monitor scale %s', async (scale, sf) => {
    const f = dragFixture(scale, sf);
    f.grip.onPointerDown(f.pointer(40));
    await flush();
    f.acceptFrame(1000);
    await flush();
    expect(widgetEffects.setPosition).toHaveBeenCalledTimes(1);
    expect(widgetEffects.setPosition.mock.calls[0][0]).toMatchObject({ x: 760, y: Math.round(960 * (sf * scale)) });
  });

  it.each([
    // [case, text scale, live ratio, scale expected for the grip centre]
    ['the live ratio of a window moved to another monitor', 1.06, 2, 2],
    ['the drag scale when the ratio is unreadable', 1.06, undefined, 1.06],
    ['the monitor scale without a text scale', 1, undefined, 1],
  ] as const)('snaps by the grip centre measured through %s', async (_, scale, ratio, expected) => {
    const f = dragFixture(scale, geo.sf, 400);
    if (ratio) vi.stubGlobal('devicePixelRatio', ratio);
    f.grip.onPointerDown(f.pointer(40));
    await flush();
    await f.grip.onPointerUp(f.pointer(40));
    const snap = nearestEdge(geo.area, 760 + 408 * expected, 40 * expected);
    expect(widgetEffects.patch).toHaveBeenCalledTimes(1);
    expect(widgetEffects.patch.mock.calls[0][0]).toMatchObject({ dockEdge: snap.edge, dockOffset: snap.offset });
    expect(widgetEffects.states[9]).toBe(false);
  });

  it.each([
    // [text scale, monitor scale, live ratio, expected clip scale]
    [1, 1, 1.25, 1.25],
    [1.06, 1.02, undefined, 1.02 * 1.06],
    [1, 1.5, undefined, 1.5],
  ] as const)('clips the dragged strip with text scale %s, monitor scale %s and live ratio %s', async (scale, sf, ratio, expected) => {
    configureNative();
    widgetEffects.textScale = scale;
    if (ratio) vi.stubGlobal('devicePixelRatio', ratio);
    const cleanup = renderWidget(true, false, sf).drag.run();
    await flush();
    expect(widgetEffects.clip).toHaveBeenCalledTimes(1);
    expect(widgetEffects.clip.mock.calls[0][0].radii).toEqual([14 * expected, 14 * expected, 0, 0]);
    if (typeof cleanup === 'function') cleanup();
  });

  it('drains every accepted RAF before snap, including an older pending dispatch', async () => {
    const f = dragFixture();
    const releases: (() => void)[] = [];
    const dispatched = new Set<number>();
    widgetEffects.setPosition.mockImplementation((position: { x: number; y: number }) => new Promise<void>(resolve => {
      const index = releases.length;
      releases.push(() => { dispatched.add(index); f.applyPosition(position); resolve(); });
    }));
    f.grip.onPointerDown(f.pointer(40));
    await flush();
    f.acceptFrame(1000);
    await flush();
    f.acceptFrame(900);
    await flush();
    const up = f.grip.onPointerUp(f.pointer(900));
    await flush();
    const earlyReads = widgetEffects.outerPosition.mock.calls.length - 1;
    // Only commands actually submitted concurrently may dispatch in reverse here.
    if (releases.length === 2) releases[1]();
    releases[0]();
    await flush();
    if (!dispatched.has(1)) releases[1]();
    await up;
    expect(earlyReads).toBe(0);
    expect(dispatched.size).toBe(2);
    expect(widgetEffects.setPosition.mock.calls.map(call => call[0].y)).toEqual([960, 860]);
    expect(widgetEffects.states[9]).toBe(false);
    expect(widgetEffects.states[0]).toMatchObject({ dockEdge: 'bottom', dockOffset: 0.4 });
    const cleanup = commitWidget().placement.run();
    await flush();
    expect(f.position()).toEqual({ x: 568, y: 1000 });
    if (typeof cleanup === 'function') cleanup();
  });

  it.each(['new gesture', 'unmount'])('drops accepted but undispatched frames after %s', async (cancel) => {
    const f = dragFixture();
    const releases: (() => void)[] = [];
    widgetEffects.setPosition.mockImplementation((position: { x: number; y: number }) => new Promise<void>(resolve => {
      releases.push(() => { f.applyPosition(position); resolve(); });
    }));
    f.grip.onPointerDown(f.pointer(40));
    await flush();
    f.acceptFrame(1000);
    await flush();
    f.acceptFrame(900);
    await flush();
    if (cancel === 'new gesture') f.grip.onPointerDown(f.pointer(40, 8));
    else if (typeof f.unmount === 'function') f.unmount();
    for (const release of [...releases]) release();
    await flush();
    expect(widgetEffects.setPosition).toHaveBeenCalledTimes(1);
    expect(widgetEffects.patch).not.toHaveBeenCalled();
    if (cancel === 'new gesture') expect(widgetEffects.states[9]).toBe(true);
  });

  it('does not let an old pointerup snap or clear a newer gesture', async () => {
    const f = dragFixture();
    f.grip.onPointerDown(f.pointer(40));
    await flush();
    let releaseRead!: (position: { x: number; y: number }) => void;
    widgetEffects.outerPosition.mockImplementationOnce(() => new Promise(resolve => { releaseRead = resolve; }));
    const oldUp = f.grip.onPointerUp(f.pointer(40));
    await flush();
    f.grip.onPointerDown(f.pointer(40, 8));
    releaseRead({ x: 760, y: 0 });
    await oldUp;
    await flush();
    expect({ patches: widgetEffects.patch.mock.calls.length, dragging: widgetEffects.states[9] })
      .toEqual({ patches: 0, dragging: true });
    f.acceptFrame(1000, 8);
    await flush();
    await f.grip.onPointerUp(f.pointer(1000, 8));
    expect(widgetEffects.patch).toHaveBeenCalledTimes(1);
    expect(widgetEffects.patch.mock.calls[0][0]).toMatchObject({ dockEdge: 'bottom' });
  });

  it('does not snap or write state after unmount during a pointerup read', async () => {
    const f = dragFixture();
    f.grip.onPointerDown(f.pointer(40));
    await flush();
    let releaseRead!: (position: { x: number; y: number }) => void;
    widgetEffects.outerPosition.mockImplementationOnce(() => new Promise(resolve => { releaseRead = resolve; }));
    const up = f.grip.onPointerUp(f.pointer(40));
    await flush();
    if (typeof f.unmount === 'function') f.unmount();
    const writes = widgetEffects.stateWrite.mock.calls.length;
    releaseRead({ x: 760, y: 0 });
    await up;
    expect(widgetEffects.patch).not.toHaveBeenCalled();
    expect(widgetEffects.stateWrite).toHaveBeenCalledTimes(writes);
  });

  it.each(['origin', 'move', 'snap'])('recovers from %s failure without stuck dragging or an unhandled rejection', async (failure) => {
    const f = dragFixture();
    if (failure === 'origin') widgetEffects.outerPosition.mockRejectedValueOnce(new Error('origin failed'));
    if (failure === 'move') widgetEffects.setPosition.mockRejectedValueOnce(new Error('move failed'));
    if (failure === 'snap') widgetEffects.patch.mockRejectedValueOnce(new Error('snap failed'));
    f.grip.onPointerDown(f.pointer(40));
    await flush();
    if (failure === 'origin') {
      expect(widgetEffects.states[9]).toBe(false);
    } else {
      f.acceptFrame(1000);
      await flush();
      await f.grip.onPointerUp(f.pointer(1000));
      expect(widgetEffects.states[9]).toBe(false);
    }
    f.grip.onPointerDown(f.pointer(40, 8));
    await flush();
    f.acceptFrame(1000, 8);
    await flush();
    await f.grip.onPointerUp(f.pointer(1000, 8));
    expect(widgetEffects.states[9]).toBe(false);
    expect(widgetEffects.patch.mock.calls.at(-1)?.[0]).toMatchObject({ dockEdge: 'bottom' });
  });

  it.each(['onPointerUp', 'onPointerCancel'] as const)('preserves RAF coalescing and settles the accepted frame on %s', async (finish) => {
    const f = dragFixture();
    f.grip.onPointerDown(f.pointer(40));
    await flush();
    f.grip.onPointerMove(f.pointer(800));
    f.grip.onPointerMove(f.pointer(1000));
    expect(f.frames.size).toBe(1);
    f.runFrame();
    await flush();
    await f.grip[finish](f.pointer(1000));
    expect(widgetEffects.setPosition).toHaveBeenCalledTimes(1);
    expect(widgetEffects.setPosition.mock.calls[0][0]).toMatchObject({ x: 760, y: 960 });
    expect(widgetEffects.patch.mock.calls[0][0]).toMatchObject({ dockEdge: 'bottom' });
    expect(widgetEffects.states[9]).toBe(false);
  });

  it('cancels an unaccepted RAF at pointerup and ignores another pointer', async () => {
    const f = dragFixture();
    f.grip.onPointerDown(f.pointer(40));
    await flush();
    await f.grip.onPointerUp(f.pointer(1000, 8));
    expect(widgetEffects.states[9]).toBe(true);
    expect(widgetEffects.patch).not.toHaveBeenCalled();
    f.grip.onPointerMove(f.pointer(1000));
    expect(f.frames.size).toBe(1);
    await f.grip.onPointerUp(f.pointer(1000));
    expect(f.frames.size).toBe(0);
    expect(widgetEffects.setPosition).not.toHaveBeenCalled();
    expect(widgetEffects.patch.mock.calls[0][0]).toMatchObject({ dockEdge: 'top' });
    expect(widgetEffects.states[9]).toBe(false);
  });

  it.each(['new gesture', 'unmount'])('ignores a snap response arriving after %s', async (cancel) => {
    const f = dragFixture();
    f.grip.onPointerDown(f.pointer(40));
    await flush();
    let releasePatch!: (config: unknown) => void;
    widgetEffects.patch.mockImplementationOnce(() => new Promise(resolve => { releasePatch = resolve; }));
    const oldUp = f.grip.onPointerUp(f.pointer(40));
    await flush();
    expect(widgetEffects.patch).toHaveBeenCalledTimes(1);
    if (cancel === 'new gesture') f.grip.onPointerDown(f.pointer(40, 8));
    else if (typeof f.unmount === 'function') f.unmount();
    const writes = widgetEffects.stateWrite.mock.calls.length;
    releasePatch({ dockEdge: 'left', accounts: [], nineRouter: { baseUrl: '' } });
    await oldUp;
    await flush();
    expect(widgetEffects.stateWrite).toHaveBeenCalledTimes(writes);
    expect(widgetEffects.states[0]).toBeNull();
    if (cancel === 'new gesture') {
      expect(widgetEffects.states[9]).toBe(true);
      f.acceptFrame(1000, 8);
      await flush();
      await f.grip.onPointerUp(f.pointer(1000, 8));
      expect(widgetEffects.states[0]).toMatchObject({ dockEdge: 'bottom' });
    }
  });

  it('cancels a queued drag clip when a newer placement supersedes it', async () => {
    configureNative();
    let releaseBounds!: () => void;
    const pending = new Promise<void>(resolve => { releaseBounds = resolve; });
    widgetEffects.bounds.mockImplementationOnce(() => pending);
    const cleanupDock = renderWidget(false).placement.run();
    await flush();
    expect(widgetEffects.bounds).toHaveBeenCalledTimes(1);
    if (typeof cleanupDock === 'function') cleanupDock();

    const cleanupDrag = renderWidget(true).drag.run();
    if (typeof cleanupDrag === 'function') cleanupDrag();
    const cleanupLatest = renderWidget(false).placement.run();
    releaseBounds();
    await flush();

    expect(widgetEffects.innerSize).not.toHaveBeenCalled();
    expect(widgetEffects.bounds).toHaveBeenCalledTimes(2);
    expect(widgetEffects.clip).toHaveBeenCalledTimes(1);
    expect(widgetEffects.show).toHaveBeenCalledTimes(1);
    if (typeof cleanupLatest === 'function') cleanupLatest();
  });

  it('rejects a late drag size result before clipping or showing a newer placement', async () => {
    configureNative();
    let releaseSize!: (size: { width: number; height: number }) => void;
    const pending = new Promise<{ width: number; height: number }>(resolve => { releaseSize = resolve; });
    widgetEffects.innerSize.mockImplementationOnce(() => pending);
    const cleanupDrag = renderWidget(true).drag.run();
    await flush();
    expect(widgetEffects.innerSize).toHaveBeenCalledTimes(1);
    if (typeof cleanupDrag === 'function') cleanupDrag();

    const cleanupLatest = renderWidget(false).placement.run();
    releaseSize({ width: 400, height: 80 });
    await flush();

    expect(widgetEffects.bounds).toHaveBeenCalledTimes(1);
    expect(widgetEffects.clip).toHaveBeenCalledTimes(1);
    expect(widgetEffects.show).toHaveBeenCalledTimes(1);
    if (typeof cleanupLatest === 'function') cleanupLatest();
  });

  it.each([false, true])('finishes an outstanding docked clip before same-size drag with autoHide=%s', async (autoHide) => {
    const events: string[] = [];
    const releases: (() => void)[] = [];
    let rounded = false;
    widgetEffects.bounds.mockResolvedValue(undefined);
    widgetEffects.show.mockResolvedValue(undefined);
    widgetEffects.innerSize.mockResolvedValue({ width: 400, height: 80 });
    widgetEffects.clip.mockImplementation((clip: { radii: number[] }) => {
      const name = clip.radii[2] === 0 ? 'docked' : 'drag';
      events.push(`${name}:start`);
      return new Promise<void>((resolve) => releases.push(() => { events.push(`${name}:end`); resolve(); }));
    });
    vi.stubGlobal('getComputedStyle', () => ({
      borderTopLeftRadius: '14px', borderTopRightRadius: '14px',
      borderBottomRightRadius: rounded ? '14px' : '0px',
      borderBottomLeftRadius: rounded ? '14px' : '0px',
    }));
    const cleanup = renderWidget(false).placement.run();
    await flush();
    expect(events).toEqual(['docked:start']);

    if (typeof cleanup === 'function') cleanup();
    rounded = true;
    const cleanupDrag = renderWidget(true, autoHide).drag.run();
    await flush();
    // Release in submission order. A shared lane must not have submitted drag yet.
    releases[0]();
    await flush();
    expect(releases).toHaveLength(2);
    releases[1]();
    await flush();
    expect(events).toEqual(['docked:start', 'docked:end', 'drag:start', 'drag:end']);
    expect(widgetEffects.show).not.toHaveBeenCalled();
    expect(widgetEffects.clip.mock.calls.map(call => [call[0].width, call[0].height]))
      .toEqual([[400, 80], [400, 80]]);
    expect(widgetEffects.clip.mock.calls.map(call => call[1])).toEqual([true, !autoHide]);
    if (typeof cleanupDrag === 'function') cleanupDrag();
  });

  // #250/S22: el detalle declara que no pudo colocarse (`placement-failed`) y
  // la tira decide qué hacer con el aviso (cerrar el panel, como en un cierre
  // normal). Un aviso de una sesión vieja se ignora.
  const renderStrip = (autoHide: boolean) => {
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.effects = [];
    widgetEffects.states[0] = { autoHide, accounts: [], nineRouter: { baseUrl: '' }, alerts: { threshold: 90 } };
    widgetEffects.states[5] = geo;
    widgetEffects.states[6] = { w: 400, h: 80 };
    widgetEffects.states[9] = false;
    let tree: ReactNode = null;
    function CaptureStrip() { tree = Widget(); return tree; }
    renderToStaticMarkup(createElement(CaptureStrip));
    // La sesión de detalle vigente: revisión 5, proveedor 'a'.
    widgetEffects.refs[7].current = { revision: 5, report: { id: 'a' } };
    // Cada prueba usa sus propios listeners.
    widgetEffects.listeners.delete('detail-interaction');
    widgetEffects.listeners.delete('detail-dismiss');
    const listener = widgetEffects.effects.find((e) => e.run.toString().includes('DETAIL_EVENTS.interaction'));
    const autoHideEffect = widgetEffects.effects.find((e) => e.run.toString().includes('const busy ='));
    expect(listener).toBeDefined();
    expect(autoHideEffect).toBeDefined();
    return { listener: listener!, autoHideEffect: autoHideEffect!, tree };
  };

  it('closes the panel and frees the strip when the detail declares a placement failure (#250/S22)', async () => {
    const setTimeoutSpy = vi.fn();
    vi.stubGlobal('window', { clearTimeout: vi.fn(), setTimeout: setTimeoutSpy });
    widgetEffects.states[7] = { providerId: 'a', anchored: true }; // Panel abierto y anclado.
    widgetEffects.states[12] = true; // `collapsed`: la tira está replegada.
    const { listener, autoHideEffect } = renderStrip(true);
    // El puntero está dentro del detalle.
    widgetEffects.refs[10].current = 'detail';
    // El cleanup del efecto llama a `emitTo(...).catch(...)` y el doble del
    // arnés devuelve `undefined`: el efecto se deja vivo a propósito.
    listener.run();
    await flush();
    const handlers = widgetEffects.listeners.get('detail-interaction') ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    // Con el panel abierto, la tira está ocupada: el auto-ocultar la mantiene
    // visible y no programa el repliegue.
    autoHideEffect.run();
    expect(widgetEffects.states[12]).toBe(false);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    // El detalle declara que no pudo colocarse...
    for (const handler of handlers) handler({ payload: { revision: 5, provider: 'a', kind: 'placement-failed' } });
    // ...la tira cierra el panel...
    expect(widgetEffects.states[7]).toEqual({ providerId: null, anchored: false });
    // ...y el detalle ya no cuenta como superficie bajo el puntero.
    expect(widgetEffects.refs[10].current).toBe('outside');
    // Con el panel cerrado, la tira ya no está ocupada: el auto-ocultar vuelve
    // a replegarla (la tira se repinta con el panel ya cerrado).
    const after = renderStrip(true);
    after.autoHideEffect.run();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores a placement failure notice from a stale detail session (#250/S22)', async () => {
    vi.stubGlobal('window', { clearTimeout: vi.fn(), setTimeout: vi.fn() });
    widgetEffects.states[7] = { providerId: 'a', anchored: true };
    const { listener } = renderStrip(false);
    widgetEffects.refs[10].current = 'detail';
    listener.run();
    await flush();
    const handlers = widgetEffects.listeners.get('detail-interaction') ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    // Otra revisión: el aviso es viejo.
    for (const handler of handlers) handler({ payload: { revision: 4, provider: 'a', kind: 'placement-failed' } });
    expect(widgetEffects.states[7]).toEqual({ providerId: 'a', anchored: true });
    // Otro proveedor: la sesión ya no es la vigente.
    for (const handler of handlers) handler({ payload: { revision: 5, provider: 'other', kind: 'placement-failed' } });
    expect(widgetEffects.states[7]).toEqual({ providerId: 'a', anchored: true });
    expect(widgetEffects.refs[10].current).toBe('detail');
  });

  it('still closes the panel when the backend dismisses the detail (#250/S22)', async () => {
    vi.stubGlobal('window', { clearTimeout: vi.fn(), setTimeout: vi.fn() });
    widgetEffects.states[7] = { providerId: 'a', anchored: true };
    const { listener } = renderStrip(false);
    widgetEffects.refs[10].current = 'detail';
    listener.run();
    await flush();
    const dismiss = widgetEffects.listeners.get('detail-dismiss') ?? [];
    expect(dismiss.length).toBeGreaterThan(0);
    for (const handler of dismiss) handler();
    expect(widgetEffects.states[7]).toEqual({ providerId: null, anchored: false });
    expect(widgetEffects.refs[10].current).toBe('outside');
  });

  // El cierre pedido por el detalle es idéntico al cierre normal: también
  // cancela los temporizadores pendientes. Sin eso, una apertura ya agendada
  // (el puntero sobre otro orbe) reabrió el panel justo después del aviso.
  it('cancels the pending open timer when the detail declares a placement failure (#250/S22)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
      addEventListener: () => {}, removeEventListener: () => {},
    });
    // Un orbe visible: el puntero puede pasar por encima y agendar la apertura.
    widgetEffects.states[1] = [{
      id: 'a', name: 'A', kind: 'subscription', status: 'ok', plan: null, meters: [], spend: null,
      message: null, action: null, fetchedAt: '2026-11-01T00:00:00Z',
    } as unknown as UsageReport];
    // El panel está cerrado: la apertura del orbe queda pendiente.
    widgetEffects.states[7] = { providerId: null, anchored: false };
    const { listener, tree } = renderStrip(false);
    const hover = findOrbHover(tree);
    expect(hover).toBeDefined();
    listener.run();
    await flush();
    const handlers = widgetEffects.listeners.get('detail-interaction') ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    // El puntero pasa por encima del orbe: la apertura queda agendada...
    hover!({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 56, height: 56 }) } as HTMLElement);
    expect(widgetEffects.states[7]).toEqual({ providerId: null, anchored: false });
    // ...y el detalle declara que no pudo colocarse.
    for (const handler of handlers) handler({ payload: { revision: 5, provider: 'a', kind: 'placement-failed' } });
    // La apertura pendiente se cancela: el panel no se abre.
    await vi.advanceTimersByTimeAsync(2000);
    expect(widgetEffects.states[7]).toEqual({ providerId: null, anchored: false });
  });
});

describe('the localized placement reason', () => {
  const geo = {
    area: { x: 0, y: 0, w: 1920, h: 1080 }, sf: 1, monitor: null,
    screen: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  // Hook slots of Widget (useDockReveal/useUpdaterMode are isolated above):
  // 0 config, 5 geo, 6 stripSize, 16 placementFailed, 17 placementReason.
  const markup = (locale: 'es' | 'en' = 'es', failed = true) => {
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.effects = [];
    widgetEffects.states[0] = { autoHide: true, locale, accounts: [], nineRouter: { baseUrl: '' } };
    widgetEffects.states[5] = geo;
    widgetEffects.states[6] = { w: 400, h: 80 };
    widgetEffects.states[16] = failed;
    widgetEffects.states[17] = failed ? 'size_refused' : null;
    return renderToStaticMarkup(createElement(Widget));
  };

  afterEach(() => {
    widgetEffects.states = [];
    widgetEffects.refs = [];
    widgetEffects.effects = [];
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it('carries the machine-readable code and shows the localized reason', () => {
    const es = markup('es');
    // El atributo lleva el código, no el texto: es machine-readable.
    expect(es).toContain('data-placement-reason="size_refused"');
    // El texto visible sale del catálogo, en el idioma de la ventana.
    expect(es).toContain('title="el gestor no concedió el tamaño"');
    expect(es).toContain('aria-label="Reintentar mostrar Quorb: el gestor no concedió el tamaño"');
    // El código aparece una sola vez: en el atributo machine-readable, nunca
    // en el texto visible.
    expect(es.split('size_refused').length - 1).toBe(1);

    const en = markup('en');
    expect(en).toContain('data-placement-reason="size_refused"');
    expect(en).toContain('title="the window manager did not grant the size"');
    expect(en).toContain('aria-label="Retry showing Quorb: the window manager did not grant the size"');
  });

  it('keeps the upstream retry text when no placement failed', () => {
    // Sin fallo de colocación el botón conserva el texto del catálogo de
    // upstream (#195): ni motivo, ni título, ni atributo de motivo.
    const es = markup('es', false);
    expect(es).toContain('aria-label="Mostrar Quorb"');
    expect(es).not.toContain('data-placement-reason');
    expect(es).not.toContain('size_refused');
    const en = markup('en', false);
    expect(en).toContain('aria-label="Show Quorb"');
    expect(en).not.toContain('data-placement-reason');
  });
});

// #250 (S16): the close decision follows the pointer presence model, never a
// flag that only one of the two surfaces owns. On Wayland native the strip's
// `mouseleave` is dropped, so the detail's own `leave` has to arm the close.
describe('hover presence wiring', () => {
  const geo = {
    area: { x: 0, y: 0, w: 1920, h: 1080 }, sf: 1, monitor: null,
    screen: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  const report = {
    id: 'a', name: 'A', kind: 'subscription', status: 'ok', plan: null, meters: [], spend: null,
    message: null, action: null, fetchedAt: '2026-11-01T00:00:00Z',
  } as unknown as UsageReport;
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

  /**
   * The real strip handlers and the real detail interaction listener: the
   * strip's `mouseenter`/`mouseleave` come from the rendered tree and the
   * detail's `enter`/`leave` from the listener the Widget registers.
   */
  const wire = async (anchored = false, panel: PanelState = { providerId: 'a', anchored }) => {
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.effects = [];
    widgetEffects.states[0] = null;
    widgetEffects.states[1] = [report];
    widgetEffects.states[5] = geo;
    widgetEffects.states[6] = { w: 400, h: 80 };
    widgetEffects.states[7] = panel;
    widgetEffects.states[9] = false;
    let dock: DockHandlers | undefined;
    let hover: ((el: HTMLElement) => void) | undefined;
    let orbs: OrbPointer[] = [];
    function CaptureWidget() {
      const tree = Widget();
      dock = findDock(tree); // Real handlers from the returned JSX, not copied logic.
      hover = findOrbHover(tree); // The orb's own `mouseenter`, the one that reads the hold.
      orbs = findOrbPointers(tree); // The orb's reorder handlers.
      return tree;
    }
    renderToStaticMarkup(createElement(CaptureWidget));
    // The detail state effect publishes the revision that the interaction carries.
    // Its deps start with the active report; with no panel there is no active
    // report and they start with `null`. Either way it is the only effect whose
    // second dep is the geometry and whose dep list is the long one.
    const detailState = widgetEffects.effects.find((e) => e.deps?.[0] === report)
      ?? widgetEffects.effects.find((e) => e.deps?.[1] === geo && e.deps.length > 10)!;
    detailState.run();
    const published = widgetEffects.refs
      .map((r) => r.current)
      .find((v): v is { revision: number; report: { id: string } } =>
        !!v && typeof v === 'object' && 'report' in v)!;
    // The listener that receives the detail window's interaction events.
    widgetEffects.listeners.delete(DETAIL_EVENTS.interaction);
    // The listener that receives the native pointer relay (#264/S16).
    widgetEffects.listeners.delete(POINTER_SURFACE_EVENT);
    const listener = widgetEffects.effects.find((e) => e.run.toString().includes('DETAIL_EVENTS.interaction'))!;
    listener.run();
    await flush();
    const handlers = (widgetEffects.listeners.get(DETAIL_EVENTS.interaction) ?? []) as ((event: { payload: unknown }) => void)[];
    const nativeHandlers = (widgetEffects.listeners.get(POINTER_SURFACE_EVENT) ?? []) as ((event: { payload: unknown }) => void)[];
    return {
      dock: dock!,
      /** The orb's `mouseenter`: the only path that reads the reorder hold. */
      hover: hover!,
      /** The reorder handlers of the orbs of the strip. */
      orbs,
      /** The effect that publishes the detail state (and its presence write). */
      detailState: () => detailState.run(),
      detail: (kind: 'enter' | 'leave') => handlers.forEach((h) => (
        h({ payload: { revision: published.revision, provider: 'a', kind } })
      )),
      /** The native relay of the backend: GTK's enter/leave (#264/S16). */
      native: (surface: 'widget' | 'detail', kind: 'enter' | 'leave') => nativeHandlers.forEach((h) => (
        h({ payload: { surface, kind } })
      )),
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
      // The viewport of the strip: the reorder hold needs to know if the
      // pointer was released inside the window.
      innerWidth: 1920, innerHeight: 1080,
    });
  });

  afterEach(() => {
    widgetEffects.states = [];
    widgetEffects.refs = [];
    widgetEffects.effects = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('closes the detail when it reports leave even if the strip never reported mouseleave', async () => {
    const { dock, detail } = await wire();
    dock.onMouseEnter(); // The pointer enters the strip.
    detail('enter'); // The detail window reports the pointer inside it.
    // The strip's `mouseleave` never arrives: Wayland native drops it.
    detail('leave'); // The detail window reports the pointer left it.
    expect(widgetEffects.states[7]).toMatchObject({ providerId: 'a' });
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[7]).toEqual(NO_PANEL);
  });

  it('closes the detail when the strip reports leave and the pointer is outside both surfaces', async () => {
    const { dock } = await wire();
    dock.onMouseEnter();
    dock.onMouseLeave();
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[7]).toEqual(NO_PANEL);
  });

  it('keeps the detail open while the pointer is inside it', async () => {
    const { dock, detail } = await wire();
    dock.onMouseEnter();
    dock.onMouseLeave(); // Arms the close.
    detail('enter'); // The detail cancels it.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[7]).toMatchObject({ providerId: 'a' });
  });

  it('keeps the detail open when the pointer returns to the strip', async () => {
    const { dock, detail } = await wire();
    detail('enter');
    detail('leave'); // Arms the close.
    dock.onMouseEnter(); // The strip cancels it.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[7]).toMatchObject({ providerId: 'a' });
  });

  it('releases the strip presence when the detail reports enter', async () => {
    const { dock, detail } = await wire();
    dock.onMouseEnter();
    expect(widgetEffects.states[11]).toBe(true); // The strip knows the pointer is on it.
    detail('enter');
    // The pointer cannot be in the two windows at once: the strip's presence
    // is invalid, so its auto-hide is not frozen any more.
    expect(widgetEffects.states[11]).toBe(false);
  });

  // #264/S13: la salida de la tira que llega mucho después de la evidencia
  // del detalle es autoridad. El modelo no puede quedarse pegado a una
  // presencia vieja: si la salida del detalle se pierde, la única evidencia
  // real —la salida de la tira— cerraba el panel con el puntero fuera.
  it('closes the detail when the strip reports a late leave after the detail entered (#264/S13)', async () => {
    const { dock, detail } = await wire();
    dock.onMouseEnter();
    detail('enter');
    // La salida del detalle se pierde (Wayland native) y la de la tira llega
    // mucho después: es la única evidencia que queda del puntero.
    await vi.advanceTimersByTimeAsync(3000);
    dock.onMouseLeave();
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[7]).toEqual(NO_PANEL);
  });

  // #264/S14: la misma salida pegada al gesto (pocos ms) es el resto de ese
  // gesto: no cierra un panel que el usuario está leyendo.
  it('keeps the detail open when the strip leaves within the same gesture (#264/S14)', async () => {
    const { dock, detail } = await wire();
    dock.onMouseEnter();
    detail('enter');
    dock.onMouseLeave(); // Pega al `enter` del detalle: mismo gesto.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[7]).toMatchObject({ providerId: 'a' });
  });

  // #264/S16: GTK entrega el `leave` de la ventana del detalle aunque
  // WebKitGTK no lo traduzca al DOM. Ese relé nativo es otra fuente de
  // presencia de esa superficie: sin él, el panel queda abierto (S1).
  it('closes the detail after a native leave of the detail window (#264/S16)', async () => {
    const { dock, detail, native } = await wire();
    dock.onMouseEnter();
    detail('enter'); // El DOM sí entrega la entrada al detalle.
    native('detail', 'leave'); // La salida llega sólo por el relé nativo.
    expect(widgetEffects.states[7]).toMatchObject({ providerId: 'a' });
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[7]).toEqual(NO_PANEL);
  });

  // #264/S16: la entrada nativa es la misma evidencia que la del DOM: si el
  // puntero vuelve a la superficie, el cierre ya armado se cancela y el
  // panel no parpadea.
  it('cancels a pending close when a native enter arrives (#264/S16)', async () => {
    const { dock, detail, native } = await wire();
    dock.onMouseEnter();
    detail('enter');
    detail('leave'); // Arma el cierre.
    await vi.advanceTimersByTimeAsync(100);
    expect(widgetEffects.states[7]).toMatchObject({ providerId: 'a' });
    native('detail', 'enter'); // El puntero vuelve: el cierre se cancela.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[7]).toMatchObject({ providerId: 'a' });
  });

  // #264/S16: la salida nativa de la tira también cierra: es la misma
  // evidencia que el `mouseleave` del DOM.
  it('closes the detail after a native leave of the strip (#264/S16)', async () => {
    const { dock, native } = await wire();
    dock.onMouseEnter();
    native('widget', 'leave'); // La salida de la tira llega por el relé nativo.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[7]).toEqual(NO_PANEL);
  });

  // #264: el nativo manda cuando existe. En cuanto llega el primer cruce
  // nativo, el DOM deja de decidir la presencia: la segunda salida ya no
  // rearma el timer ni lo atrasa (R1).
  it('closes the detail at the native leave even when the DOM leave arrives later (#264/R1)', async () => {
    const { dock, native } = await wire();
    dock.onMouseEnter();
    native('widget', 'leave'); // La salida real de la tira llega por el relé nativo.
    await vi.advanceTimersByTimeAsync(100);
    dock.onMouseLeave(); // El DOM también avisa, más tarde: ya no manda.
    await vi.advanceTimersByTimeAsync(180); // 280 ms desde la salida nativa.
    expect(widgetEffects.states[7]).toEqual(NO_PANEL);
  });

  // #264 (R2): en Wayland puede llegar `enter nativo → leave nativo → enter
  // DOM` sin el `leave` DOM, que WebKitGTK pierde. Con el DOM mandando, la
  // entrada tardía cancela el cierre y el panel queda pegado.
  it('closes the detail when the native crossings arrive and the DOM enter comes later (#264/R2)', async () => {
    const { detail, native } = await wire();
    native('detail', 'enter'); // El puntero entra al detalle (nativo).
    native('detail', 'leave'); // Y sale (nativo): el cierre se arma.
    detail('enter'); // El DOM avisa la entrada tarde: ya no manda.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[7]).toEqual(NO_PANEL);
  });

  // #264: sin ningún cruce nativo el DOM sigue decidiendo la presencia, que
  // es el caso de Windows y macOS (allí no llega ningún cruce nativo).
  it('keeps closing from the DOM alone when no native crossing has arrived (#264)', async () => {
    const { dock, detail } = await wire();
    dock.onMouseEnter();
    detail('enter');
    detail('leave'); // Sólo el DOM: el cierre se arma y el panel se cierra.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[7]).toEqual(NO_PANEL);
  });

  // #170/#223: que un panel anclado siga abierto es intencional. El modelo
  // decide el cierre por hover, así que tiene que respetar esa salida: con el
  // panel anclado, salir de las dos superficies no arma ningún cierre.
  it('keeps an anchored detail open when the pointer leaves both surfaces (#170/#223)', async () => {
    const { dock, detail } = await wire(true);
    dock.onMouseEnter();
    detail('enter');
    detail('leave');
    dock.onMouseLeave();
    // Más que el retardo de cierre: si el guard del anclaje desapareciera, el
    // timer se armaría y el panel se cerraría solo.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[7]).toEqual({ providerId: 'a', anchored: true });
  });

  // #264/S19: el bloqueo del hover tras reordenar (#222/#240) lo libera el
  // único escritor del modelo de presencia: cuando la presencia pasa de
  // `widget` a otro estado, el puntero dejó la tira. Antes lo liberaba sólo
  // el `mouseleave` del DOM, que en Wayland nativo se pierde (#264/S16).
  //
  // El bloqueo se observa por su efecto, no por el ref: con el bloqueo puesto
  // el hover sobre el orbe no abre el detalle; liberado, lo abre.
  describe('the reorder hold follows the presence model (#264/S19)', () => {
    /** El orbe como lo ve el hover: sólo necesita su rectángulo. */
    const orbElement = { getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }) };

    /**
     * Reordena de verdad: arrastra el orbe y lo suelta encima de la tira.
     * Es lo que pone el bloqueo del hover (#222).
     */
    const reorder = (orbs: OrbPointer[]) => {
      const orb = orbs.find((o) => o.id === 'a')!;
      const target = { setPointerCapture: () => {}, releasePointerCapture: () => {} };
      orb.onPointerDown({ button: 0, clientX: 10, clientY: 10, pointerId: 1, currentTarget: target });
      orb.onPointerMove({ clientX: 40, clientY: 10, pointerId: 1, currentTarget: target });
      orb.onPointerUp({ clientX: 40, clientY: 10, pointerId: 1, currentTarget: target });
    };

    /**
     * El hover sobre el orbe, ya fuera de la guarda del reordenamiento
     * (400 ms): antes de eso lo frena el gesto, no el bloqueo.
     */
    const hoverAfterTheGuard = async (hover: (el: HTMLElement) => void) => {
      await vi.advanceTimersByTimeAsync(500);
      hover(orbElement as unknown as HTMLElement);
    };

    // El puntero sale de la tira y la salida llega sólo por el relé nativo:
    // es el camino que se perdía en Wayland nativo (#264/S16).
    it('releases the hold when the pointer leaves the strip natively (#264/S19)', async () => {
      const { dock, native, hover, orbs } = await wire();
      dock.onMouseEnter(); // El puntero está sobre la tira.
      reorder(orbs); // El reordenamiento bloquea el hover (#222).
      native('widget', 'leave'); // La salida llega sólo por el relé nativo.
      await hoverAfterTheGuard(hover);
      expect(widgetEffects.states[7]).toEqual({ providerId: 'a', anchored: false });
    });

    // El puntero pasa de la tira al detalle: ya no está en la tira, así que
    // el bloqueo se suelta aunque el `mouseleave` de la tira no llegue nunca.
    it('releases the hold when the pointer moves from the strip to the detail (#264/S19)', async () => {
      const { dock, detail, hover, orbs } = await wire();
      dock.onMouseEnter();
      reorder(orbs);
      detail('enter'); // El puntero entra al detalle.
      await hoverAfterTheGuard(hover);
      expect(widgetEffects.states[7]).toEqual({ providerId: 'a', anchored: false });
    });

    // #222: el detalle se cierra con el puntero encima del orbe (justo al
    // soltar un reordenamiento). Esa escritura deja la presencia en `widget`,
    // así que NO puede liberar el bloqueo: si lo liberara, el panel se abriría
    // solo. Esta prueba tiene que pasar antes de implementar el cambio.
    it('keeps the hold when the presence stays on the strip (#264/S19, #222)', async () => {
      const { dock, hover, orbs, detailState } = await wire(false, NO_PANEL);
      dock.onMouseEnter();
      reorder(orbs);
      detailState(); // El detalle se cierra con el puntero sobre la tira.
      await hoverAfterTheGuard(hover);
      // La apertura retardada del hover, si el bloqueo no estuviera puesto.
      await vi.advanceTimersByTimeAsync(400);
      expect(widgetEffects.states[7]).toEqual(NO_PANEL);
    });

    // Sin cruce nativo (Windows y macOS) la salida del DOM sigue siendo la
    // que libera el bloqueo.
    it('keeps releasing the hold on the DOM exit of the strip (#264/S19)', async () => {
      const { dock, hover, orbs } = await wire();
      dock.onMouseEnter();
      reorder(orbs);
      dock.onMouseLeave(); // La salida del DOM: Windows y macOS.
      await hoverAfterTheGuard(hover);
      expect(widgetEffects.states[7]).toEqual({ providerId: 'a', anchored: false });
    });
  });
});

// #264/L18: arrastrar un orbe hacia la derecha reordenaba el DOM, y mover un
// nodo con `insertBefore` libera la captura del puntero: el gesto se cortaba
// a mitad de camino (el `lostpointercapture` llegaba 10-30 ms después del
// cambio de índice). El DOM no se reordena durante el arrastre; la vista
// previa del orden nuevo la cuenta la propiedad CSS `order` de cada orbe
// (`.strip__orbs` es flex).
describe('the reorder preview keeps the DOM still (#264/L18)', () => {
  const geo = {
    area: { x: 0, y: 0, w: 1920, h: 1080 }, sf: 1, monitor: null,
    screen: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  const report = (id: string) => ({
    id, name: id, kind: 'subscription', status: 'ok', plan: null, meters: [], spend: null,
    message: null, action: null, fetchedAt: '2026-11-01T00:00:00Z',
  } as unknown as UsageReport);

  /** Los orbes del markup: su id y su `order` de CSS, en el orden del DOM. */
  const orbs = (markup: string) =>
    [...markup.matchAll(/<button[^>]*class="orb eg-gauge"[^>]*>/g)].map((m) => ({
      id: m[0].match(/data-id="([^"]*)"/)?.[1],
      order: m[0].match(/style="([^"]*)"/)?.[1]?.match(/(?:^|;)\s*order:\s*(\d+)/)?.[1],
    }));

  // Hook slots of Widget (useDockReveal/useUpdaterMode are isolated above):
  // 0 config, 1 reports, 5 geo, 6 stripSize, 19 reorder. Ref slots: 6 orbsRef,
  // 26 orbDrag.
  const render = (reorder: { id: string; order: string[] } | null) => {
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.effects = [];
    widgetEffects.states[0] = {
      providerOrder: ['a', 'b', 'c'], hiddenProviders: [], accounts: [], nineRouter: { baseUrl: '' },
      alerts: { threshold: 90 },
    };
    widgetEffects.states[1] = [report('a'), report('b'), report('c')];
    widgetEffects.states[5] = geo;
    widgetEffects.states[6] = { w: 400, h: 80 };
    widgetEffects.states[9] = false;
    widgetEffects.states[19] = reorder;
    let tree: ReactNode = null;
    function CaptureWidget() { tree = Widget(); return tree; }
    const markup = renderToStaticMarkup(createElement(CaptureWidget));
    return { markup, tree: tree! };
  };
  const markup = (reorder: { id: string; order: string[] } | null) => render(reorder).markup;

  afterEach(() => {
    widgetEffects.states = [];
    widgetEffects.refs = [];
    widgetEffects.effects = [];
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the saved DOM order while the preview moves an orb to the right', () => {
    const list = orbs(markup({ id: 'a', order: ['b', 'a', 'c'] }));
    // El DOM no se movió: sigue el orden guardado.
    expect(list.map((o) => o.id)).toEqual(['a', 'b', 'c']);
    // La vista previa la cuenta el `order` de CSS de cada orbe.
    expect(list.map((o) => o.order)).toEqual(['1', '0', '2']);
  });

  it('keeps the saved DOM order while the preview moves an orb to the end', () => {
    const list = orbs(markup({ id: 'a', order: ['b', 'c', 'a'] }));
    expect(list.map((o) => o.id)).toEqual(['a', 'b', 'c']);
    expect(list.map((o) => o.order)).toEqual(['2', '0', '1']);
  });

  it('renders the saved order with no CSS order outside the gesture', () => {
    const list = orbs(markup(null));
    expect(list.map((o) => o.id)).toEqual(['a', 'b', 'c']);
    // Fuera del arrastre el DOM y el orden visual coinciden: no hay `order`,
    // y el foco con teclado sigue el orden que se ve.
    expect(list.map((o) => o.order)).toEqual([undefined, undefined, undefined]);
  });

  // El índice de destino lo decide la posición visual, no el orden del DOM:
  // el DOM conserva el orden guardado, así que los centros llegan desordenados.
  it('drops the dragged orb at its visual position, not at the DOM one', () => {
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    // La vista previa pone a 'b' al final: en pantalla el orden es a, c, b.
    const { tree } = render({ id: 'a', order: ['a', 'c', 'b'] });
    const dragged = findOrbPointers(tree).find((o) => o.id === 'a')!;
    // El DOM sigue el orden guardado (a, b, c) con las posiciones de la vista
    // previa: a en la ranura 0, c en la 1 y b en la 2.
    widgetEffects.refs[6].current = {
      querySelectorAll: () => [
        { dataset: { id: 'a' }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 60, height: 60 }) },
        { dataset: { id: 'b' }, getBoundingClientRect: () => ({ left: 200, top: 0, width: 60, height: 60 }) },
        { dataset: { id: 'c' }, getBoundingClientRect: () => ({ left: 100, top: 0, width: 60, height: 60 }) },
      ],
    };
    dragged.onPointerDown({
      button: 0, clientX: 30, clientY: 30, pointerId: 1,
      currentTarget: { setPointerCapture: () => {} },
    });
    // El puntero cae entre 'c' (centro 130) y 'b' (centro 230).
    dragged.onPointerMove({ clientX: 150, clientY: 30 });
    expect(widgetEffects.states[19]).toEqual({ id: 'a', order: ['c', 'a', 'b'] });
  });
});
