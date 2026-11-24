import widget from '../Widget.tsx?raw';
import { Widget } from '../Widget';
import { createElement, isValidElement, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import hook from './useDockReveal.ts?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finishReveal,
  peekRect,
  readyReveal,
  requestReveal,
  usesPeekWindow,
  waitForViewport,
  watchPreparation,
  REVEAL_DURATION,
  type RevealPhase,
} from './auto-hide';
import { resetDragMode, setDragMode } from './drag-session';
import { contains, nearestEdge, panelHeightLimit, stripRect, type Edge } from './dock';
import { DETAIL_EVENTS, physicalPanelBounds } from './detail-panel';
import { POINTER_SURFACE_EVENT } from './hover-presence';
import type { DetailPresence } from './detail-presence';
import { NO_PANEL, type PanelState } from './anchor-panel';
import type { UsageReport } from './types';
import { SLOT, SKIP, WIDGET_REFS, WIDGET_STATE_COUNT, WIDGET_REF_COUNT, WIDGET_STATES } from './test-slots';

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

/** The enter handler of an orb by id (real props of the tree). */
function findOrbEnterById(node: ReactNode, id: string): ((el: HTMLElement) => void) | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const enter = findOrbEnterById(child, id);
      if (enter) return enter;
    }
    return;
  }
  if (!isValidElement<{ report?: { id: string }; onPointerEnter?: (el: HTMLElement) => void; children?: ReactNode }>(node)) return;
  if (node.props.report?.id === id && node.props.onPointerEnter) return node.props.onPointerEnter;
  return findOrbEnterById(node.props.children, id);
}

/** The leave handler of the first orb of the strip (real props of the tree). */
function findOrbLeave(node: ReactNode): (() => void) | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const leave = findOrbLeave(child);
      if (leave) return leave;
    }
    return;
  }
  if (!isValidElement<{ onPointerLeave?: () => void; children?: ReactNode }>(node)) return;
  if (node.props.onPointerLeave) return node.props.onPointerLeave;
  return findOrbLeave(node.props.children);
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
  onPointerCancel(event: unknown): void;
  /** El anclaje por clic (#170/#223): el único camino a `anchorOn`. */
  onClick?(el: HTMLElement): void;
};

/** The reorder handlers of every orb of the strip (real props of the tree). */
function findOrbPointers(node: ReactNode, out: OrbPointer[] = []): OrbPointer[] {
  if (Array.isArray(node)) {
    for (const child of node) findOrbPointers(child, out);
    return out;
  }
  if (!isValidElement<{ report?: { id: string }; pointer?: Omit<OrbPointer, 'id'>; onClick?: (el: HTMLElement) => void; children?: ReactNode }>(node))
    return out;
  if (node.props.pointer && node.props.report) out.push({ id: node.props.report.id, ...node.props.pointer, onClick: node.props.onClick });
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
// Ref slots: useWidgetStartup consumes refs[0] (generation) before Widget's
// own refs, so the drag/detail refs below start at 1 (#271, revisión).
const widgetEffects = vi.hoisted(() => ({
  states: [] as unknown[],
  stateIndex: 0,
  // Iniciales que Widget pasa a cada useState/useRef, en orden de render.
  // El test de coherencia (#286) los compara contra la tabla de slots.
  stateInitials: [] as unknown[],
  refInitials: [] as unknown[],
  // Recuentos esperados de la tabla de slots (#286): el mock no puede importar
  // el módulo (hoisting), así que el test los inyecta aquí ANTES de renderizar
  // (`widgetEffects.expectedStateCount = WIDGET_STATE_COUNT`). Si un render
  // crea más hooks de los declarados, el guard estalla en el punto exacto.
  expectedStateCount: null as number | null,
  expectedRefCount: null as number | null,
  refs: [] as { current: unknown }[],
  refIndex: 0,
  getConfig: vi.fn(),
  openSettings: vi.fn(),
  effects: [] as { run: () => void | (() => void); deps?: readonly unknown[]; name?: string }[],
  bounds: vi.fn(),
  clip: vi.fn(),
  show: vi.fn(),
  innerSize: vi.fn(),
  outerPosition: vi.fn(),
  setPosition: vi.fn(),
  monitors: vi.fn(),
  patch: vi.fn(),
  stateWrite: vi.fn(),
  cancel: vi.fn(async () => {}),
  listeners: new Map<string, ((event?: { payload?: unknown }) => void)[]>(),
  // Hook results isolated from the useState slots: text scale (#228) and reveal phase.
  textScale: undefined as number | undefined,
  phase: undefined as RevealPhase | undefined,
}));
vi.mock('react', async (importOriginal) => {
  const react = (await importOriginal()) as typeof import('react');
  return {
    ...react,
    useState: ((initial?: unknown) => {
      const index = widgetEffects.stateIndex++;
      widgetEffects.stateInitials.push(initial);
      // Disparidad temprana con la tabla de slots (#286): si el render crea
      // más useState de los declarados, falla aquí, en el punto exacto.
      // Los recuentos se inyectan desde el test (el factory no puede importar).
      const expected = widgetEffects.expectedStateCount;
      if (expected != null && index >= expected) {
        throw new Error(`El Widget crea más useState (${index + 1}) de los que declara la tabla de slots (#286). Actualiza src/lib/test-slots.ts.`);
      }
      const value = index in widgetEffects.states ? widgetEffects.states[index] : typeof initial === 'function' ? initial() : initial;
      // Commit state explicitly in tests, but preserve the actual updater result.
      return [
        value,
        vi.fn((next: unknown) => {
          widgetEffects.stateWrite(index, next);
          const previous = index in widgetEffects.states ? widgetEffects.states[index] : value;
          widgetEffects.states[index] = typeof next === 'function' ? next(previous) : next;
        }),
      ];
    }) as typeof react.useState,
    useRef: ((initial: unknown) => {
      const index = widgetEffects.refIndex++;
      widgetEffects.refInitials.push(initial);
      const expected = widgetEffects.expectedRefCount;
      if (expected != null && index >= expected) {
        throw new Error(`El Widget crea más useRef (${index + 1}) de los que declara la tabla de slots (#286). Actualiza src/lib/test-slots.ts.`);
      }
      widgetEffects.refs[index] ??= { current: initial };
      return widgetEffects.refs[index];
    }) as typeof react.useRef,
    useEffect: ((run, deps) => {
      // El nombre del efecto: el arnés lo busca por nombre y no por el texto
      // de su fuente, que se rompe con cualquier refactor (#279/S19).
      widgetEffects.effects.push({ run, deps, name: (run as { name?: string }).name });
    }) as typeof react.useEffect,
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
vi.mock('./api', () => ({
  api: {
    setWidgetBounds: widgetEffects.bounds,
    setSurfaceClip: widgetEffects.clip,
    patchConfig: widgetEffects.patch,
    cancelWidgetPlacement: widgetEffects.cancel,
    getConfig: widgetEffects.getConfig,
    openSettings: widgetEffects.openSettings,
  },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    show: widgetEffects.show,
    innerSize: widgetEffects.innerSize,
    outerPosition: widgetEffects.outerPosition,
    setPosition: widgetEffects.setPosition,
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

// Recuentos esperados de la tabla de slots (#286): el mock no puede importar
// `test-slots` (hoisting de `vi.mock`), así que el test los inyecta en el
// objeto hoisted. El guard NO se activa globalmente: los componentes de los
// orbs (ProviderLogo tiene un `useState` para el fallback de imagen rota)
// añaden hooks suyos cuando hay informes visibles, así que un Widget CON datos
// consume más hooks que el Widget vacío de la tabla. El test de coherencia
// activa el guard sobre un render sin orbs, donde la secuencia es exactamente
// la declarada en `test-slots.ts`.

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
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function clock() {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        frames.set(++next, cb);
        return next;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    });
    return {
      frames,
      frame: () => {
        const batch = [...frames.values()];
        frames.clear();
        for (const cb of batch) cb(0);
      },
    };
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
    const pending = waitForViewport().then(() => {
      done = true;
    });
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

  it('gates the peek on a known locale so it is never a button without an accessible name while config is pending (#271)', () => {
    // Mientras la config está pendiente el botón peek no se monta: no queda un
    // botón activo sin nombre accesible. Con idioma seguro (config cargada o
    // fallo definitivo en `es`) sí se monta, con el ternario original de
    // `placementFailed` (el gate `configKnown` garantiza el idioma, revisión
    // PR #282: no se pierde el motivo del fallo de ubicación en `failed`).
    expect(widget).toContain('showHandle && configKnown &&');
    expect(widget).toContain("aria-label={placementFailed ? `${t(locale, 'widget.retryShow')}");
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
    area: { x: 0, y: 0, w: 1920, h: 1080 },
    sf: 1,
    monitor: null,
    screen: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  const commitWidget = () => {
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.effects = [];
    let grip: GripHandlers | undefined;
    // biome-ignore lint/correctness/noComponentHookFactories: test harness component that captures the tree of a single render; it is never mounted by React.
    function CaptureWidget() {
      const tree = Widget();
      grip = findGrip(tree); // Real handlers from the returned JSX, not copied drag logic.
      return tree;
    }
    renderToStaticMarkup(createElement(CaptureWidget));
    // Refs de Widget: [0]=generation (hook), [1]=stripRef, [2]=peekRef (#271).
    widgetEffects.refs[SLOT.stripRef].current = { dataset: {} };
    widgetEffects.refs[SLOT.peekRef].current = { dataset: {} };
    return {
      placement: widgetEffects.effects.find((e) => e.deps?.[0] === widgetEffects.states[SLOT.geo])!,
      drag: widgetEffects.effects.find((e) => e.deps?.[0] === widgetEffects.states[SLOT.dragging] && e.deps?.[1] === widgetEffects.states[SLOT.geo])!,
      grip: grip!,
    };
  };
  const renderWidget = (dragging: boolean, autoHide = false, sf = geo.sf) => {
    // Hook slots belong to Widget (useDockReveal/useUpdaterMode are isolated above).
    widgetEffects.states[SLOT.config] = autoHide ? { autoHide, accounts: [], nineRouter: { baseUrl: '' } } : null;
    widgetEffects.states[SLOT.geo] = sf === geo.sf ? geo : { ...geo, sf };
    widgetEffects.states[SLOT.stripSize] = { w: 400, h: 80 };
    widgetEffects.states[SLOT.dragging] = dragging;
    return commitWidget();
  };
  // Text scale (#228): the strip is measured in CSS px and placed in monitor units.
  const renderScaled = (scale: number, sf: number, phase: RevealPhase = 'open') => {
    widgetEffects.textScale = scale;
    widgetEffects.phase = phase;
    widgetEffects.states[SLOT.config] = null;
    widgetEffects.states[SLOT.geo] = { ...geo, sf };
    widgetEffects.states[SLOT.stripSize] = { w: 400, h: 80 };
    widgetEffects.states[SLOT.dragging] = false;
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
      strip,
      win,
      bounds: widgetEffects.bounds.mock.calls[0]?.[0],
      clip: widgetEffects.clip.mock.calls[0]?.[0],
      pos: widgetEffects.states[SLOT.pos],
    };
  };
  const configureNative = () => {
    widgetEffects.bounds.mockResolvedValue(undefined);
    widgetEffects.clip.mockResolvedValue(undefined);
    widgetEffects.show.mockResolvedValue(undefined);
    widgetEffects.innerSize.mockResolvedValue({ width: 400, height: 80 });
    vi.stubGlobal('getComputedStyle', () => ({
      borderTopLeftRadius: '14px',
      borderTopRightRadius: '14px',
      borderBottomRightRadius: '0px',
      borderBottomLeftRadius: '0px',
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

  it.each([
    [1, 1],
    [1.06, 1.02],
    [1.25, 1.5],
  ])('sends the detail the text-scaled strip and orb anchor (text %s, monitor %s)', (scale, sf) => {
    const report = {
      id: 'a',
      name: 'A',
      kind: 'subscription',
      status: 'ok',
      plan: null,
      meters: [],
      spend: null,
      message: null,
      action: null,
      fetchedAt: '2026-11-01T00:00:00Z',
    } as unknown as UsageReport;
    widgetEffects.states[SLOT.reports] = [report];
    widgetEffects.states[SLOT.panel] = { providerId: 'a', anchored: true };
    widgetEffects.states[SLOT.anchorRel] = 30; // Orb centre in CSS px from the strip start.
    renderScaled(scale, sf);
    const detail = widgetEffects.effects.find((e) => e.deps?.[0] === report)!;
    detail.run();
    const sent = widgetEffects.refs.find((r) => (r.current as { report?: unknown } | null)?.report === report)!.current;
    const strip = stripRect(geo.area, 'top', 0.5, 400 * scale, 80 * scale);
    expect(sent).toMatchObject({
      strip,
      anchor: strip.x + 30 * scale,
      scaleFactor: sf,
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
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    renderWidget(false);
    // El usuario oculta la tira desde la bandeja: la visibilidad es suya.
    const listener = widgetEffects.effects.find((e) => e.run.toString().includes('widget-hidden'));
    const cleanupListener = listener!.run();
    await flush();
    for (const handler of widgetEffects.listeners.get('widget-hidden') ?? []) handler();
    // La red de seguridad (2,5 s) muestra la ventana si el ciclo no llegó a
    // mostrarla: tampoco puede contradecir al usuario.
    const safetyNet = widgetEffects.effects.find((e) => e.deps?.length === 1 && e.run.toString().includes('setTimeout'));
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
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    renderWidget(false);
    const safetyNet = widgetEffects.effects.find((e) => e.deps?.length === 1 && e.run.toString().includes('setTimeout'));
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
    widgetEffects.monitors.mockResolvedValue([
      {
        name: 'display',
        scaleFactor: 1,
        position: { x: 0, y: 0 },
        size: { width: 1920, height: 1080 },
      },
    ]);
    widgetEffects.setPosition.mockImplementation((position: { x: number; y: number }) => {
      // Hold the async core command BEFORE native enqueue/ack. Once released,
      // apply and acknowledge together: there is no post-ack FIFO reordering.
      return new Promise<void>((resolve) => {
        releasePosition = () => {
          nativeDispatches++;
          nativePosition = { x: position.x, y: position.y };
          resolve();
        };
        if (!delayBeforeDispatch) releasePosition();
      });
    });
    widgetEffects.patch.mockImplementation(async (patch: { dockEdge: Edge; dockOffset: number; dockMonitor: string | null }) => ({
      accounts: [],
      nineRouter: { baseUrl: '' },
      ...patch,
    }));
    widgetEffects.bounds.mockImplementation(async (bounds: { x: number; y: number }) => {
      nativePosition = { x: bounds.x, y: bounds.y };
    });
    const target = {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 16, height: 80 }),
    };
    const pointer = (screenY: number) =>
      ({
        button: 0,
        pointerId: 7,
        screenX: 768,
        screenY,
        currentTarget: target,
        target: { closest: () => target },
        preventDefault: vi.fn(),
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
      if (!snapCommitted && widgetEffects.states[SLOT.dragging] === false && widgetEffects.patch.mock.calls.length > 0) {
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
      const canonical = widgetEffects.states[SLOT.config] as { dockEdge: Edge; dockOffset: number };
      expect({ earlyReads, earlySnaps, edge: canonical.dockEdge, offset: canonical.dockOffset, nativePosition }).toEqual({
        earlyReads: delayBeforeDispatch ? 0 : 1,
        earlySnaps: delayBeforeDispatch ? 0 : 1,
        edge: 'bottom',
        offset: 0.4,
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
    widgetEffects.monitors.mockResolvedValue([
      {
        name: 'display',
        scaleFactor: 1,
        position: { x: 0, y: 0 },
        size: { width: 1920, height: 1080 },
      },
    ]);
    widgetEffects.setPosition.mockImplementation(async (next: { x: number; y: number }) => {
      position = { ...next };
    });
    widgetEffects.patch.mockImplementation(async (patch: { dockEdge: Edge; dockOffset: number }) => ({
      accounts: [],
      nineRouter: { baseUrl: '' },
      ...patch,
    }));
    widgetEffects.bounds.mockImplementation(async (bounds: { x: number; y: number }) => {
      position = { x: bounds.x, y: bounds.y };
    });
    const target = {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      getBoundingClientRect: () => ({ left: gripLeft, top: 0, width: 16, height: 80 }),
    };
    const pointer = (screenY: number, pointerId = 7) =>
      ({
        button: 0,
        pointerId,
        screenX: 768,
        screenY,
        currentTarget: target,
        target: { closest: () => target },
        preventDefault: vi.fn(),
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
    const unmount = widgetEffects.effects.find((e) => e.name === 'dragMountLifecycle')!.run();
    return {
      grip,
      pointer,
      acceptFrame,
      runFrame,
      frames,
      position: () => position,
      unmount,
      applyPosition: (next: { x: number; y: number }) => {
        position = { x: next.x, y: next.y };
      },
    };
  };

  // PointerEvent.screenX is CSS px on Windows (#228, L7): physical = Δcss × sf × t.
  it.each([
    [1.06, 1],
    [1.2, 1.25],
  ])('moves the window by the CSS pointer delta times text scale %s and monitor scale %s', async (scale, sf) => {
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
    expect(widgetEffects.states[SLOT.dragging]).toBe(false);
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
    widgetEffects.setPosition.mockImplementation(
      (position: { x: number; y: number }) =>
        new Promise<void>((resolve) => {
          const index = releases.length;
          releases.push(() => {
            dispatched.add(index);
            f.applyPosition(position);
            resolve();
          });
        }),
    );
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
    expect(widgetEffects.setPosition.mock.calls.map((call) => call[0].y)).toEqual([960, 860]);
    expect(widgetEffects.states[SLOT.dragging]).toBe(false);
    expect(widgetEffects.states[SLOT.config]).toMatchObject({ dockEdge: 'bottom', dockOffset: 0.4 });
    const cleanup = commitWidget().placement.run();
    await flush();
    expect(f.position()).toEqual({ x: 568, y: 1000 });
    if (typeof cleanup === 'function') cleanup();
  });

  it.each(['new gesture', 'unmount'])('drops accepted but undispatched frames after %s', async (cancel) => {
    const f = dragFixture();
    const releases: (() => void)[] = [];
    widgetEffects.setPosition.mockImplementation(
      (position: { x: number; y: number }) =>
        new Promise<void>((resolve) => {
          releases.push(() => {
            f.applyPosition(position);
            resolve();
          });
        }),
    );
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
    if (cancel === 'new gesture') expect(widgetEffects.states[SLOT.dragging]).toBe(true);
  });

  it('does not let an old pointerup snap or clear a newer gesture', async () => {
    const f = dragFixture();
    f.grip.onPointerDown(f.pointer(40));
    await flush();
    let releaseRead!: (position: { x: number; y: number }) => void;
    widgetEffects.outerPosition.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        }),
    );
    const oldUp = f.grip.onPointerUp(f.pointer(40));
    await flush();
    f.grip.onPointerDown(f.pointer(40, 8));
    releaseRead({ x: 760, y: 0 });
    await oldUp;
    await flush();
    expect({ patches: widgetEffects.patch.mock.calls.length, dragging: widgetEffects.states[SLOT.dragging] }).toEqual({ patches: 0, dragging: true });
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
    widgetEffects.outerPosition.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        }),
    );
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
      expect(widgetEffects.states[SLOT.dragging]).toBe(false);
    } else {
      f.acceptFrame(1000);
      await flush();
      await f.grip.onPointerUp(f.pointer(1000));
      expect(widgetEffects.states[SLOT.dragging]).toBe(false);
    }
    f.grip.onPointerDown(f.pointer(40, 8));
    await flush();
    f.acceptFrame(1000, 8);
    await flush();
    await f.grip.onPointerUp(f.pointer(1000, 8));
    expect(widgetEffects.states[SLOT.dragging]).toBe(false);
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
    expect(widgetEffects.states[SLOT.dragging]).toBe(false);
  });

  it('cancels an unaccepted RAF at pointerup and ignores another pointer', async () => {
    const f = dragFixture();
    f.grip.onPointerDown(f.pointer(40));
    await flush();
    await f.grip.onPointerUp(f.pointer(1000, 8));
    expect(widgetEffects.states[SLOT.dragging]).toBe(true);
    expect(widgetEffects.patch).not.toHaveBeenCalled();
    f.grip.onPointerMove(f.pointer(1000));
    expect(f.frames.size).toBe(1);
    await f.grip.onPointerUp(f.pointer(1000));
    expect(f.frames.size).toBe(0);
    expect(widgetEffects.setPosition).not.toHaveBeenCalled();
    expect(widgetEffects.patch.mock.calls[0][0]).toMatchObject({ dockEdge: 'top' });
    expect(widgetEffects.states[SLOT.dragging]).toBe(false);
  });

  it.each(['new gesture', 'unmount'])('ignores a snap response arriving after %s', async (cancel) => {
    const f = dragFixture();
    f.grip.onPointerDown(f.pointer(40));
    await flush();
    let releasePatch!: (config: unknown) => void;
    widgetEffects.patch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePatch = resolve;
        }),
    );
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
    expect(widgetEffects.states[SLOT.config]).toBeNull();
    if (cancel === 'new gesture') {
      expect(widgetEffects.states[SLOT.dragging]).toBe(true);
      f.acceptFrame(1000, 8);
      await flush();
      await f.grip.onPointerUp(f.pointer(1000, 8));
      expect(widgetEffects.states[SLOT.config]).toMatchObject({ dockEdge: 'bottom' });
    }
  });

  it('cancels a queued drag clip when a newer placement supersedes it', async () => {
    configureNative();
    let releaseBounds!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseBounds = resolve;
    });
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
    const pending = new Promise<{ width: number; height: number }>((resolve) => {
      releaseSize = resolve;
    });
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
      return new Promise<void>((resolve) =>
        releases.push(() => {
          events.push(`${name}:end`);
          resolve();
        }),
      );
    });
    vi.stubGlobal('getComputedStyle', () => ({
      borderTopLeftRadius: '14px',
      borderTopRightRadius: '14px',
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
    expect(widgetEffects.clip.mock.calls.map((call) => [call[0].width, call[0].height])).toEqual([
      [400, 80],
      [400, 80],
    ]);
    expect(widgetEffects.clip.mock.calls.map((call) => call[1])).toEqual([true, !autoHide]);
    if (typeof cleanupDrag === 'function') cleanupDrag();
  });

  // #250/S22: el detalle declara que no pudo colocarse (`placement-failed`) y
  // la tira decide qué hacer con el aviso (cerrar el panel, como en un cierre
  // normal). Un aviso de una sesión vieja se ignora.
  const renderStrip = (autoHide: boolean) => {
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.effects = [];
    widgetEffects.states[SLOT.config] = { autoHide, accounts: [], nineRouter: { baseUrl: '' }, alerts: { threshold: 90 } };
    widgetEffects.states[SLOT.geo] = geo;
    widgetEffects.states[SLOT.stripSize] = { w: 400, h: 80 };
    widgetEffects.states[SLOT.dragging] = false;
    let tree: ReactNode = null;
    // biome-ignore lint/correctness/noComponentHookFactories: test harness component that captures the tree of a single render; it is never mounted by React.
    function CaptureStrip() {
      tree = Widget();
      return tree;
    }
    renderToStaticMarkup(createElement(CaptureStrip));
    // La sesión de detalle vigente: revisión 5, proveedor 'a'.
    widgetEffects.refs[SLOT.detailStateRef].current = { revision: 5, report: { id: 'a' } };
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
    widgetEffects.states[SLOT.panel] = { providerId: 'a', anchored: true }; // Panel abierto y anclado.
    widgetEffects.states[SLOT.collapsed] = true; // `collapsed`: la tira está replegada.
    const { listener, autoHideEffect } = renderStrip(true);
    // El cleanup del efecto llama a `emitTo(...).catch(...)` y el doble del
    // arnés devuelve `undefined`: el efecto se deja vivo a propósito.
    listener.run();
    await flush();
    const handlers = widgetEffects.listeners.get('detail-interaction') ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    // El puntero está dentro del detalle: lo dice el propio detalle, no un
    // hook leído por posición (#264/S32).
    for (const handler of handlers) handler({ payload: { revision: 5, provider: 'a', kind: 'enter' } });
    // Con el panel abierto, la tira está ocupada: el auto-ocultar la mantiene
    // visible y no programa el repliegue.
    autoHideEffect.run();
    expect(widgetEffects.states[SLOT.collapsed]).toBe(false);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    // El detalle declara que no pudo colocarse...
    for (const handler of handlers) handler({ payload: { revision: 5, provider: 'a', kind: 'placement-failed' } });
    // ...la tira cierra el panel...
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: null, anchored: false });
    // ...y la tira queda libre: el auto-ocultar puede replegarla (abajo).
    // Con el panel cerrado, la tira ya no está ocupada: el auto-ocultar vuelve
    // a replegarla (la tira se repinta con el panel ya cerrado).
    const after = renderStrip(true);
    after.autoHideEffect.run();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores a placement failure notice from a stale detail session (#250/S22)', async () => {
    vi.stubGlobal('window', { clearTimeout: vi.fn(), setTimeout: vi.fn() });
    widgetEffects.states[SLOT.panel] = { providerId: 'a', anchored: true };
    const { listener } = renderStrip(false);
    listener.run();
    await flush();
    const handlers = widgetEffects.listeners.get('detail-interaction') ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    // El puntero está dentro del detalle: lo dice el propio detalle, no un
    // hook leído por posición (#264/S32).
    for (const handler of handlers) handler({ payload: { revision: 5, provider: 'a', kind: 'enter' } });
    // Otra revisión: el aviso es viejo.
    for (const handler of handlers) handler({ payload: { revision: 4, provider: 'a', kind: 'placement-failed' } });
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: true });
    // Otro proveedor: la sesión ya no es la vigente.
    for (const handler of handlers) handler({ payload: { revision: 5, provider: 'other', kind: 'placement-failed' } });
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: true });
  });

  it('still closes the panel when the backend dismisses the detail (#250/S22)', async () => {
    vi.stubGlobal('window', { clearTimeout: vi.fn(), setTimeout: vi.fn() });
    widgetEffects.states[SLOT.panel] = { providerId: 'a', anchored: true };
    const { listener } = renderStrip(false);
    listener.run();
    await flush();
    const handlers = widgetEffects.listeners.get('detail-interaction') ?? [];
    // El puntero está dentro del detalle: lo dice el propio detalle, no un
    // hook leído por posición (#264/S32).
    for (const handler of handlers) handler({ payload: { revision: 5, provider: 'a', kind: 'enter' } });
    const dismiss = widgetEffects.listeners.get('detail-dismiss') ?? [];
    expect(dismiss.length).toBeGreaterThan(0);
    for (const handler of dismiss) handler();
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: null, anchored: false });
  });

  // El cierre pedido por el detalle es idéntico al cierre normal: también
  // cancela los temporizadores pendientes. Sin eso, una apertura ya agendada
  // (el puntero sobre otro orbe) reabrió el panel justo después del aviso.
  it('cancels the pending open timer when the detail declares a placement failure (#250/S22)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    // Un orbe visible: el puntero puede pasar por encima y agendar la apertura.
    widgetEffects.states[SLOT.reports] = [
      {
        id: 'a',
        name: 'A',
        kind: 'subscription',
        status: 'ok',
        plan: null,
        meters: [],
        spend: null,
        message: null,
        action: null,
        fetchedAt: '2026-11-01T00:00:00Z',
      } as unknown as UsageReport,
    ];
    // El panel está cerrado: la apertura del orbe queda pendiente.
    widgetEffects.states[SLOT.panel] = { providerId: null, anchored: false };
    const { listener, tree } = renderStrip(false);
    const hover = findOrbHover(tree);
    expect(hover).toBeDefined();
    listener.run();
    await flush();
    const handlers = widgetEffects.listeners.get('detail-interaction') ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    // El puntero pasa por encima del orbe: la apertura queda agendada...
    hover!({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 56, height: 56 }) } as HTMLElement);
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: null, anchored: false });
    // ...y el detalle declara que no pudo colocarse.
    for (const handler of handlers) handler({ payload: { revision: 5, provider: 'a', kind: 'placement-failed' } });
    // La apertura pendiente se cancela: el panel no se abre.
    await vi.advanceTimersByTimeAsync(2000);
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: null, anchored: false });
  });
});

describe('the localized placement reason', () => {
  const geo = {
    area: { x: 0, y: 0, w: 1920, h: 1080 },
    sf: 1,
    monitor: null,
    screen: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  // Hook slots of Widget (useDockReveal/useUpdaterMode are isolated above);
  // `useWidgetStartup` toma los tres primeros: 0 config, 1 configFailed,
  // 2 configError. Después: 7 geo, 8 stripSize, 18 placementFailed,
  // 19 placementReason.
  const markup = (locale: 'es' | 'en' = 'es', failed = true) => {
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.effects = [];
    widgetEffects.states[SLOT.config] = { autoHide: true, locale, accounts: [], nineRouter: { baseUrl: '' } };
    widgetEffects.states[SLOT.geo] = geo;
    widgetEffects.states[SLOT.stripSize] = { w: 400, h: 80 };
    widgetEffects.states[SLOT.placementFailed] = failed;
    widgetEffects.states[SLOT.placementReason] = failed ? 'size_refused' : null;
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

  // #271 (precisión 2): el peek es un botón activo; mientras la config está
  // pendiente no debe montarse sin nombre accesible. Se monta con `autoHide`
  // activo y fase colapsada para aislar el gate de `configKnown`.
  it('hides the peek entirely while the config is pending (no button without a name)', () => {
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.effects = [];
    widgetEffects.phase = 'hidden';
    widgetEffects.states[SLOT.config] = null; // config pendiente
    widgetEffects.states[SLOT.geo] = { ...geo, sf: 1 };
    widgetEffects.states[SLOT.stripSize] = { w: 400, h: 80 };
    const html = renderToStaticMarkup(createElement(Widget));
    expect(html).not.toContain('class="peek"');
    widgetEffects.phase = undefined;
  });

  it('shows the peek with an accessible name in the default locale once the config load fails definitively', () => {
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.effects = [];
    widgetEffects.phase = 'hidden';
    widgetEffects.states[SLOT.config] = null; // config sigue null
    widgetEffects.states[SLOT.configFailed] = true; // configFailed
    widgetEffects.states[SLOT.geo] = { ...geo, sf: 1 };
    widgetEffects.states[SLOT.stripSize] = { w: 400, h: 80 };
    const html = renderToStaticMarkup(createElement(Widget));
    expect(html).toContain('class="peek"');
    expect(html).toContain('aria-label="Mostrar Quorb"');
    widgetEffects.phase = undefined;
  });
});

// Cableado real de Widget respecto al arranque de la configuración (#271,
// precisión 3 revisada): a diferencia de `use-widget-startup.test.ts` (que lee
// los slots del hook), aquí se renderiza el Widget completo con los hooks
// mockeados y se comprueba qué expone la primera muestra: ausencia de
// «Cargando…»/«Ajustes» en pending, nombres en inglés al resolver, fallo
// definitivo con «Reintentar» + tools en `es`, un error ajeno que no rompe el
// neutro, y la colocación normal (efecto real) mostrando antes del temporizador.
describe('Widget startup wiring (#271, revisión)', () => {
  const geo = {
    area: { x: 0, y: 0, w: 1920, h: 1080 },
    sf: 1,
    monitor: null,
    screen: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  const flush = async () => {
    for (let i = 0; i < 24; i++) await Promise.resolve();
  };
  /** Renderiza el Widget completo y devuelve el HTML SSR actual. */
  const renderHtml = () => {
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.effects = [];
    return renderToStaticMarkup(createElement(Widget));
  };
  /** `window` de Node para el temporizador de la red de seguridad. */
  const installFakeWindowTimers = () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
  };
  const configureNative = () => {
    widgetEffects.bounds.mockResolvedValue(undefined);
    widgetEffects.clip.mockResolvedValue(undefined);
    // Tanto la red de seguridad (`showStripIfVisible`) como la colocación
    // normal hacen `await getCurrentWindow().show()`; sin resolución el mock
    // devuelve `undefined` y el `.catch` de la red de seguridad explota.
    widgetEffects.show.mockResolvedValue(undefined);
    widgetEffects.innerSize.mockResolvedValue({ width: 400, height: 80 });
    vi.stubGlobal('getComputedStyle', () => ({
      borderTopLeftRadius: '14px',
      borderTopRightRadius: '14px',
      borderBottomRightRadius: '0px',
      borderBottomLeftRadius: '0px',
    }));
    // El efecto de colocación mide el surface montado; los refs se llenan en
    // el render de SSR, aquí los simulamos para que `measureSurfaceClip` pueda
    // leer los radios.
    widgetEffects.refs[SLOT.stripRef] ??= { current: null }; // stripRef
    widgetEffects.refs[SLOT.stripRef].current = { dataset: {} };
    widgetEffects.refs[SLOT.peekRef] ??= { current: null }; // peekRef
    widgetEffects.refs[SLOT.peekRef].current = { dataset: {} };
    setDragMode('native');
  };
  /** Config pendiente: estado base para todos los casos. */
  const pendingStates = () => {
    widgetEffects.states[SLOT.config] = null; // config pendiente
    widgetEffects.states[SLOT.geo] = geo;
    widgetEffects.states[SLOT.stripSize] = { w: 400, h: 80 };
    // `Widget` inicialmente marca la red de seguridad como ya pasada; lo que
    // queremos probar es el efecto de colocación mostrando antes del timer.
    widgetEffects.refs[SLOT.shown] ??= { current: false }; // shown (refs[0] = generation del hook)
    widgetEffects.refs[SLOT.shown].current = false;
  };

  afterEach(() => {
    widgetEffects.states = [];
    widgetEffects.refs = [];
    widgetEffects.effects = [];
    widgetEffects.phase = undefined;
    resetDragMode();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('pending + safety net: show() fires and the first render has no Cargando/Ajustes; resolving to en shows English names', async () => {
    installFakeWindowTimers();
    widgetEffects.show.mockResolvedValue(undefined);
    let resolveConfig!: (c: unknown) => void;
    widgetEffects.getConfig.mockReturnValue(
      new Promise((res) => {
        resolveConfig = res;
      }),
    );
    pendingStates();
    const first = renderHtml();
    // Neutro sin texto localizado, aunque el idioma guardado sea inglés.
    expect(first).toContain('strip__pending');
    expect(first).not.toContain('Cargando');
    expect(first).not.toContain('Ajustes');

    // Ejecutar la carga (getConfig pendiente) y la red de seguridad de 2,5 s.
    const load = widgetEffects.effects.find((e) => e.run.toString().includes('getConfig'))!;
    const safety = widgetEffects.effects.find((e) => e.deps?.length === 1 && e.run.toString().includes('setTimeout'))!;
    const cleanupLoad = load.run();
    const cleanupTimer = safety.run();
    await vi.advanceTimersByTimeAsync(2600);
    expect(widgetEffects.show).toHaveBeenCalledTimes(1);

    // La config en inglés llega: nombres localizados al re-render.
    resolveConfig({ locale: 'en', accounts: [], nineRouter: { baseUrl: '' } });
    await flush();
    const second = renderHtml();
    expect(second).toContain('title="Settings"');
    expect(second).not.toContain('Ajustes');
    expect(second).not.toContain('Cargando');
    if (typeof cleanupLoad === 'function') cleanupLoad();
    if (typeof cleanupTimer === 'function') cleanupTimer();
  });

  it('definitive config failure shows Reintentar with the tools named in es', async () => {
    installFakeWindowTimers();
    widgetEffects.getConfig.mockRejectedValue(new Error('sin backend'));
    pendingStates();
    renderHtml();
    const load = widgetEffects.effects.find((e) => e.run.toString().includes('getConfig'))!;
    load.run();
    // Cinco reintentos con backoff: avanzamos suficiente para agotarlos.
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(widgetEffects.states[SLOT.configFailed]).toBe(true); // configFailed
    const html = renderHtml();
    expect(html).toContain('Reintentar');
    expect(html).toContain('title="sin backend"');
    // Herramientas accesibles con el locale de fallback (`es`).
    expect(html).toContain('title="Ajustes"');
  });

  it('an unrelated usage error while pending does not break the neutral state', () => {
    pendingStates();
    widgetEffects.states[SLOT.error] = 'boom'; // error genérico (refresco/arrastre)
    const html = renderHtml();
    expect(html).toContain('strip__pending');
    expect(html).not.toContain('Cargando');
    expect(html).not.toContain('Ajustes');
    expect(html).not.toContain('Reintentar');
  });

  it('normal placement showing before the timer keeps the neutral state and does not show twice', async () => {
    configureNative();
    installFakeWindowTimers();
    widgetEffects.getConfig.mockReturnValue(new Promise(() => {})); // pendiente
    pendingStates();
    widgetEffects.states[SLOT.dragging] = false; // dragging
    renderHtml();
    // La colocación normal muestra la ventana (efecto real, no solo el timer).
    const placement = widgetEffects.effects.find((e) => e.deps?.[0] === widgetEffects.states[SLOT.geo])!;
    const cleanup = placement.run();
    await flush();
    expect(widgetEffects.show).toHaveBeenCalledTimes(1);
    // La red de seguridad llega después: no vuelve a mostrar.
    const safety = widgetEffects.effects.find((e) => e.deps?.length === 1 && e.run.toString().includes('setTimeout'))!;
    const cleanupTimer = safety.run();
    await vi.advanceTimersByTimeAsync(2600);
    expect(widgetEffects.show).toHaveBeenCalledTimes(1);
    // La neutralidad sigue vigente pese a que la ventana ya es visible.
    const html = renderHtml();
    expect(html).toContain('strip__pending');
    expect(html).not.toContain('Cargando');
    expect(html).not.toContain('Ajustes');
    if (typeof cleanup === 'function') cleanup();
    if (typeof cleanupTimer === 'function') cleanupTimer();
  });

  // Coherencia de la tabla de slots (#286): el render de Widget SIN orbs (sin
  // datos → sin ProviderLogo) consume EXACTAMENTE los useState/useRef
  // declarados, en orden de ejecución y con los iniciales esperados. Añadir o
  // reordenar un hook en Widget.tsx (o en useWidgetStartup) rompe este test y
  // obliga a tocar solo test-slots.ts. Los componentes de los orbs quedan
  // fuera a propósito: añaden hooks propios, así que la tabla declara el
  // mínimo del propio Widget.
  it('Widget consumes exactly the declared slots, in order, with matching initials (#286)', () => {
    widgetEffects.expectedStateCount = WIDGET_STATE_COUNT;
    widgetEffects.expectedRefCount = WIDGET_REF_COUNT;
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.stateInitials = [];
    widgetEffects.refInitials = [];
    widgetEffects.states = [];
    widgetEffects.refs = [];
    try {
      renderToStaticMarkup(createElement(Widget));
    } finally {
      widgetEffects.expectedStateCount = null;
      widgetEffects.expectedRefCount = null;
    }
    expect(widgetEffects.stateIndex).toBe(WIDGET_STATE_COUNT);
    expect(widgetEffects.refIndex).toBe(WIDGET_REF_COUNT);
    WIDGET_STATES.forEach((spec, i) => {
      if (spec.initial === SKIP) return;
      expect(widgetEffects.stateInitials[i], `initial de estado ${spec.name}`).toEqual(spec.initial);
    });
    WIDGET_REFS.forEach((spec, i) => {
      if (spec.initial === SKIP) return;
      expect(widgetEffects.refInitials[i], `initial de ref ${spec.name}`).toEqual(spec.initial);
    });
  });
});

// #250 (S16): the close decision follows the pointer presence model, never a
// flag that only one of the two surfaces owns. On Wayland native the strip's
// `mouseleave` is dropped, so the detail's own `leave` has to arm the close.
describe('hover presence wiring', () => {
  const geo = {
    area: { x: 0, y: 0, w: 1920, h: 1080 },
    sf: 1,
    monitor: null,
    screen: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  const report = {
    id: 'a',
    name: 'A',
    kind: 'subscription',
    status: 'ok',
    plan: null,
    meters: [],
    spend: null,
    message: null,
    action: null,
    fetchedAt: '2026-11-01T00:00:00Z',
  } as unknown as UsageReport;
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };

  /**
   * The real strip handlers and the real detail interaction listener: the
   * strip's `mouseenter`/`mouseleave` come from the rendered tree and the
   * detail's `enter`/`leave` from the listener the Widget registers.
   */
  /** El orbe que el hit-test devuelve al soltar (#264/S23): aquí no hay layout. */
  const hitOrb = { id: 'a' };

  /** Un segundo orbe de la tira: el bloqueo tras reordenar no puede cubrir la tira entera (#264/S23). */
  const reportB = {
    id: 'b',
    name: 'B',
    kind: 'subscription',
    status: 'ok',
    plan: null,
    meters: [],
    spend: null,
    message: null,
    action: null,
    fetchedAt: '2026-11-01T00:00:00Z',
  } as unknown as UsageReport;

  const wire = async (anchored = false, panel: PanelState = { providerId: 'a', anchored }) => {
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.effects = [];
    widgetEffects.states[SLOT.config] = null;
    widgetEffects.states[SLOT.reports] = [report, reportB];
    widgetEffects.states[SLOT.geo] = geo;
    widgetEffects.states[SLOT.stripSize] = { w: 400, h: 80 };
    widgetEffects.states[SLOT.panel] = panel;
    widgetEffects.states[SLOT.dragging] = false;
    let dock: DockHandlers | undefined;
    let hover: ((el: HTMLElement) => void) | undefined;
    let leave: (() => void) | undefined;
    let enterB: ((el: HTMLElement) => void) | undefined;
    let orbs: OrbPointer[] = [];
    // biome-ignore lint/correctness/noComponentHookFactories: test harness component that captures the tree of a single render; it is never mounted by React.
    function CaptureWidget() {
      const tree = Widget();
      dock = findDock(tree); // Real handlers from the returned JSX, not copied logic.
      hover = findOrbHover(tree); // The orb's own `mouseenter`, the one that reads the hold.
      leave = findOrbLeave(tree); // The orb's own `mouseleave`, the one that ends the hold.
      enterB = findOrbEnterById(tree, 'b'); // The enter of the other orb of the strip.
      orbs = findOrbPointers(tree); // The orb's reorder handlers.
      return tree;
    }
    renderToStaticMarkup(createElement(CaptureWidget));
    // The detail state effect publishes the revision that the interaction carries.
    // Its deps start with the active report; with no panel there is no active
    // report and they start with `null`. Either way it is the only effect whose
    // second dep is the geometry and whose dep list is the long one.
    const detailState =
      widgetEffects.effects.find((e) => e.deps?.[0] === report) ?? widgetEffects.effects.find((e) => e.deps?.[1] === geo && e.deps.length > 10)!;
    detailState.run();
    const published = widgetEffects.refs
      .map((r) => r.current)
      .find((v): v is { revision: number; report: { id: string } } => !!v && typeof v === 'object' && 'report' in v)!;
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
      /** The orb's `mouseleave`: the path that ends the reorder hold. */
      leave: leave!,
      /** The enter of the other orb of the strip. */
      enterB: enterB!,
      /** The reorder handlers of the orbs of the strip. */
      orbs,
      /** The effect that publishes the detail state (and its presence write). */
      detailState: () => detailState.run(),
      detail: (kind: 'enter' | 'leave') => {
        for (const h of handlers) h({ payload: { revision: published.revision, provider: 'a', kind } });
      },
      /** The native relay of the backend: GTK's enter/leave (#264/S16). */
      native: (surface: 'widget' | 'detail', kind: 'enter' | 'leave') => {
        for (const h of nativeHandlers) h({ payload: { surface, kind } });
      },
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      // The viewport of the strip: the reorder hold needs to know if the
      // pointer was released inside the window.
      innerWidth: 1920,
      innerHeight: 1080,
    });
    // #264/S23: el hit-test que lee el orbe bajo el puntero al soltar un orbe.
    // En este arnés no hay layout, así que el orbe es fijo.
    hitOrb.id = 'a';
    vi.stubGlobal('document', {
      // Un hit-test sin orbe (el puntero sobre el fondo de la tira) devuelve
      // `null`: no hay orbe bajo el puntero (#264/S31).
      elementFromPoint: () => ({ closest: () => (hitOrb.id ? { getAttribute: () => hitOrb.id } : null) }),
    });
  });

  afterEach(() => {
    widgetEffects.states = [];
    widgetEffects.refs = [];
    widgetEffects.effects = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const openShortcut = async () => {
    const el = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }) };
    widgetEffects.refs[SLOT.orbsRef].current = { querySelector: () => el };
    (widgetEffects.refs[SLOT.openPeakRef].current as () => void)();
    await vi.advanceTimersByTimeAsync(80);
  };
  const nativePresence = () => widgetEffects.refs[SLOT.presenceRef].current as DetailPresence;

  it.each(['widget', 'detail'] as const)('keeps ordinary %s hover out of the native shortcut tracker (#309)', async (surface) => {
    const { dock, detail } = await wire();
    // An ordinary entry must still cancel a pending DOM hover close.
    dock.onMouseLeave();
    if (surface === 'widget') dock.onMouseEnter();
    else detail('enter');
    expect(nativePresence().isAnyInside()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
    if (surface === 'widget') dock.onMouseLeave();
    else detail('leave');
    await vi.advanceTimersByTimeAsync(279);
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
    expect(nativePresence().isAnyInside()).toBe(false);
  });

  it.each([
    ['Windows', 'widget'],
    ['Windows', 'detail'],
    ['Linux', 'widget'],
    ['Linux', 'detail'],
  ] as const)('clears expired shortcut grace before ordinary %s %s entry (#309)', async (os, surface) => {
    vi.stubGlobal('navigator', { userAgent: os === 'Windows' ? 'Windows NT 10.0' : 'X11; Linux x86_64' });
    const commit = async () => {
      // Keep the live state and refs across renders. Run the actual Widget
      // effect on both open and CLOSED transitions, never reset the tracker
      // from the test: non-sampling platforms must still forget shortcut grace.
      const controls = await wire(false, (widgetEffects.states[SLOT.panel] as PanelState | undefined) ?? NO_PANEL);
      const presenceEffect = widgetEffects.effects.find((e) => e.deps?.length === 2 && e.deps[1] === nativePresence());
      expect(presenceEffect).toBeDefined();
      presenceEffect!.run(); // No native sampling or cleanup on Windows/Linux.
      return controls;
    };

    await commit();
    await openShortcut();
    await commit();
    await vi.advanceTimersByTimeAsync(7999);
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
    const closed = await commit();

    // Reopen via ordinary orb hover, preserving its delayed open behavior.
    closed.hover({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }) } as HTMLElement);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
    await vi.advanceTimersByTimeAsync(400);
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
    const ordinary = await commit();
    ordinary.dock.onMouseLeave();
    const clearClose = vi.spyOn(window, 'clearTimeout');
    if (surface === 'widget') ordinary.dock.onMouseEnter();
    else ordinary.detail('enter');
    expect(nativePresence().isAnyInside()).toBe(false);
    // Only DOM presence cancels the legitimate pending close; no residual
    // shortcut tracker entry may cancel it a second time.
    expect(clearClose).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
    if (surface === 'widget') ordinary.dock.onMouseLeave();
    else ordinary.detail('leave');
    await vi.advanceTimersByTimeAsync(279);
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
    expect(nativePresence().isAnyInside()).toBe(false);
  });

  it.each(['widget', 'detail'] as const)('ends shortcut grace on a relayed entry into %s (#309)', async (surface) => {
    const { native } = await wire();
    await openShortcut();
    nativePresence().sample(false, false);
    native(surface, 'enter');
    expect(nativePresence().isAnyInside()).toBe(true);
    // A missed leave between samples still uses the ordinary close delay.
    nativePresence().sample(false, false);
    await vi.advanceTimersByTimeAsync(279);
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  it('keeps a shortcut detail open for exactly eight seconds despite outside native samples (#309)', async () => {
    await wire();
    await openShortcut();
    for (let i = 0; i < 20; i++) {
      nativePresence().sample(false, false);
      await vi.advanceTimersByTimeAsync(i === 19 ? 399 : 400);
      expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a', anchored: false });
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  it.each(['widget', 'detail'] as const)('ends shortcut grace on DOM entry into %s before the next native sample (#309)', async (surface) => {
    const { dock, detail } = await wire();
    await openShortcut();
    nativePresence().sample(false, false);
    if (surface === 'widget') dock.onMouseEnter();
    else detail('enter');
    // No further entry or leave event: the next native sample must recover
    // the missed DOM leave, even though entry happened between samples.
    nativePresence().sample(false, false);
    await vi.advanceTimersByTimeAsync(279);
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
    await vi.advanceTimersByTimeAsync(1);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  it.each(['widget', 'detail'] as const)('holds a shortcut detail inside %s then closes normally on native exit (#309)', async (surface) => {
    await wire();
    await openShortcut();
    nativePresence().sample(surface === 'widget', surface === 'detail');
    await vi.advanceTimersByTimeAsync(10000);
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
    nativePresence().sample(false, false);
    await vi.advanceTimersByTimeAsync(279);
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
    await vi.advanceTimersByTimeAsync(1);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  it('restarts the eight-second lifetime on a repeated shortcut without changing provider (#309)', async () => {
    await wire();
    await openShortcut();
    nativePresence().sample(false, false);
    await vi.advanceTimersByTimeAsync(100);
    await openShortcut();
    nativePresence().sample(false, false);
    await vi.advanceTimersByTimeAsync(7999);
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  it('leaves an already-pinned detail untouched by the shortcut (#309)', async () => {
    await wire(true, { providerId: 'b', anchored: true });
    await openShortcut();
    nativePresence().sample(false, false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'b', anchored: true });
  });

  it('closes the detail when it reports leave even if the strip never reported mouseleave', async () => {
    const { dock, detail } = await wire();
    dock.onMouseEnter(); // The pointer enters the strip.
    detail('enter'); // The detail window reports the pointer inside it.
    // The strip's `mouseleave` never arrives: Wayland native drops it.
    detail('leave'); // The detail window reports the pointer left it.
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  it('closes the detail when the strip reports leave and the pointer is outside both surfaces', async () => {
    const { dock } = await wire();
    dock.onMouseEnter();
    dock.onMouseLeave();
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  it('keeps the detail open while the pointer is inside it', async () => {
    const { dock, detail } = await wire();
    dock.onMouseEnter();
    dock.onMouseLeave(); // Arms the close.
    detail('enter'); // The detail cancels it.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
  });

  it('keeps the detail open when the pointer returns to the strip', async () => {
    const { dock, detail } = await wire();
    detail('enter');
    detail('leave'); // Arms the close.
    dock.onMouseEnter(); // The strip cancels it.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
  });

  it('releases the strip presence when the detail reports enter', async () => {
    const { dock, detail } = await wire();
    dock.onMouseEnter();
    expect(widgetEffects.states[SLOT.inside]).toBe(true); // The strip knows the pointer is on it.
    detail('enter');
    // The pointer cannot be in the two windows at once: the strip's presence
    // is invalid, so its auto-hide is not frozen any more.
    expect(widgetEffects.states[SLOT.inside]).toBe(false);
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
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  // #264/S14: la misma salida pegada al gesto (pocos ms) es el resto de ese
  // gesto: no cierra un panel que el usuario está leyendo.
  it('keeps the detail open when the strip leaves within the same gesture (#264/S14)', async () => {
    const { dock, detail } = await wire();
    dock.onMouseEnter();
    detail('enter');
    dock.onMouseLeave(); // Pega al `enter` del detalle: mismo gesto.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
  });

  // #264/S16: GTK entrega el `leave` de la ventana del detalle aunque
  // WebKitGTK no lo traduzca al DOM. Ese relé nativo es otra fuente de
  // presencia de esa superficie: sin él, el panel queda abierto (S1).
  it('closes the detail after a native leave of the detail window (#264/S16)', async () => {
    const { dock, detail, native } = await wire();
    dock.onMouseEnter();
    detail('enter'); // El DOM sí entrega la entrada al detalle.
    native('detail', 'leave'); // La salida llega sólo por el relé nativo.
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
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
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
    native('detail', 'enter'); // El puntero vuelve: el cierre se cancela.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
  });

  // #264/S16: la salida nativa de la tira también cierra: es la misma
  // evidencia que el `mouseleave` del DOM.
  it('closes the detail after a native leave of the strip (#264/S16)', async () => {
    const { dock, native } = await wire();
    dock.onMouseEnter();
    native('widget', 'leave'); // La salida de la tira llega por el relé nativo.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
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
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
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
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  // #264: sin ningún cruce nativo el DOM sigue decidiendo la presencia, que
  // es el caso de Windows y macOS (allí no llega ningún cruce nativo).
  it('keeps closing from the DOM alone when no native crossing has arrived (#264)', async () => {
    const { dock, detail } = await wire();
    dock.onMouseEnter();
    detail('enter');
    detail('leave'); // Sólo el DOM: el cierre se arma y el panel se cierra.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  // #264/S20: la precedencia nativa es POR SUPERFICIE. Con un solo booleano,
  // el primer cruce nativo de cualquier superficie apagaba el DOM de las dos:
  // si el relé se engancha a la tira pero no al detalle, el detalle perdía su
  // entrada y su salida por el DOM y ya no las recuperaba.
  it('keeps the detail open when the native relay only covers the strip (#264/S20)', async () => {
    const { detail, native } = await wire();
    native('widget', 'enter'); // El relé nativo cubre la tira.
    native('widget', 'leave'); // El puntero salió de la tira: el cierre se arma.
    // El puntero entró al detalle, que no tiene relé: su entrada llega por el DOM.
    detail('enter');
    await vi.advanceTimersByTimeAsync(280);
    // Con el puntero sobre el detalle el panel no se cierra.
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
  });

  // #264/S20: el detalle sin relé conserva su salida por el DOM: si el relé
  // se enganchó a la tira pero no al detalle, la salida del detalle es la
  // única evidencia del puntero y tiene que armar el cierre.
  it('closes the detail with the DOM leave of a surface without a native relay (#264/S20)', async () => {
    const { detail, native } = await wire();
    native('widget', 'enter'); // El relé nativo cubre la tira.
    detail('enter'); // El detalle, sin relé, avisa su entrada por el DOM.
    detail('leave'); // Y su salida por el DOM: el cierre se arma.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  // #264/S20: el espejo del anterior. El relé cubre el detalle y no la tira:
  // la entrada y la salida de la tira las sigue decidiendo el DOM.
  it('keeps the detail open when the pointer returns to the strip that has no native relay (#264/S20)', async () => {
    const { dock, native } = await wire();
    native('detail', 'enter'); // El relé nativo cubre el detalle.
    native('detail', 'leave'); // El puntero salió del detalle: el cierre se arma.
    dock.onMouseEnter(); // El puntero vuelve a la tira, que no tiene relé: por el DOM.
    await vi.advanceTimersByTimeAsync(280);
    // Con el puntero sobre la tira el panel no se cierra.
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
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
    expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: true });
  });

  // #264/S21: un `leave` que se repite con la presencia ya en `outside` no
  // debe rearmar el cierre: el cierre que está corriendo es el que cierra el
  // panel, y rearmarlo lo atrasaría otros 280 ms.
  it('closes the panel 280 ms after the first exit when the exit repeats (#264/S21)', async () => {
    const { dock } = await wire();
    dock.onMouseEnter();
    dock.onMouseLeave(); // La salida arma el cierre.
    await vi.advanceTimersByTimeAsync(200);
    dock.onMouseLeave(); // La salida que se repite no lo rearma.
    await vi.advanceTimersByTimeAsync(100);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  // #264/S21: da igual cuántas salidas lleguen: el cierre sigue siendo el de
  // la primera.
  it('closes the panel 280 ms after the first exit when five exits repeat (#264/S21)', async () => {
    const { dock } = await wire();
    dock.onMouseEnter();
    for (let i = 0; i < 5; i++) {
      dock.onMouseLeave();
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(50);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  // #264/S21: entrar a una superficie cancela el cierre, así que la salida
  // que llega después de esa entrada es una salida nueva: arranca su propio
  // cierre de 280 ms.
  it('restarts the close after an entry between two exits (#264/S21)', async () => {
    const { dock, detail } = await wire();
    dock.onMouseEnter();
    dock.onMouseLeave(); // t0: el cierre se arma.
    await vi.advanceTimersByTimeAsync(100);
    detail('enter'); // t0+100: el puntero entra al detalle: el cierre se cancela.
    await vi.advanceTimersByTimeAsync(100);
    detail('leave'); // t0+200: el puntero sale: el cierre se arma de nuevo.
    await vi.advanceTimersByTimeAsync(279);
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
    await vi.advanceTimersByTimeAsync(1);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  // #264/S21: si no hay ningún cierre pendiente, la salida lo arma. Es el
  // camino de recuperación: el cierre se puede cancelar por el camino (el
  // hover del orbe o el foco del teclado cancelan los timers) y la presencia
  // queda en `outside`; la salida que llega después tiene que cerrar.
  it('arms the close when an exit arrives with no close pending (#264/S21)', async () => {
    const { dock, hover } = await wire();
    const orbElement = { getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }) };
    dock.onMouseEnter();
    dock.onMouseLeave(); // La salida arma el cierre.
    await vi.advanceTimersByTimeAsync(50);
    hover(orbElement as unknown as HTMLElement); // El hover del orbe cancela los timers.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[SLOT.panel]).toMatchObject({ providerId: 'a' });
    dock.onMouseLeave(); // Ya no hay cierre pendiente: esta salida lo arma.
    await vi.advanceTimersByTimeAsync(280);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
  });

  // #264/S21: lo mismo por el relé nativo (#264/S16): la salida que se
  // repite no rearma el cierre.
  it('closes the panel 280 ms after the first exit when the exit repeats by the native relay (#264/S21)', async () => {
    const { native } = await wire();
    native('widget', 'enter');
    native('widget', 'leave'); // La salida arma el cierre.
    await vi.advanceTimersByTimeAsync(200);
    native('widget', 'leave'); // La salida que se repite no lo rearma.
    await vi.advanceTimersByTimeAsync(100);
    expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
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
     * Es lo que pone el bloqueo del hover (#222). `dropX` es dónde se suelta:
     * dentro de la tira, o afuera (el puntero sale de la ventana).
     */
    const reorder = (orbs: OrbPointer[], dropX = 40) => {
      const orb = orbs.find((o) => o.id === 'a')!;
      const target = { setPointerCapture: () => {}, releasePointerCapture: () => {} };
      orb.onPointerDown({ button: 0, clientX: 10, clientY: 10, pointerId: 1, currentTarget: target });
      orb.onPointerMove({ clientX: 40, clientY: 10, pointerId: 1, currentTarget: target });
      orb.onPointerUp({ clientX: dropX, clientY: 10, pointerId: 1, currentTarget: target });
    };

    /**
     * El hover sobre el orbe, ya fuera de la guarda del reordenamiento
     * (300 ms): antes de eso lo frena el gesto, no el bloqueo.
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
      expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
    });

    // El puntero pasa de la tira al detalle: ya no está en la tira, así que
    // el bloqueo se suelta aunque el `mouseleave` de la tira no llegue nunca.
    it('releases the hold when the pointer moves from the strip to the detail (#264/S19)', async () => {
      const { dock, detail, hover, orbs } = await wire();
      dock.onMouseEnter();
      reorder(orbs);
      detail('enter'); // El puntero entra al detalle.
      await hoverAfterTheGuard(hover);
      expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
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
      expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
    });

    // Sin cruce nativo (Windows y macOS) la salida del DOM sigue siendo la
    // que libera el bloqueo.
    it('keeps releasing the hold on the DOM exit of the strip (#264/S19)', async () => {
      const { dock, hover, orbs } = await wire();
      dock.onMouseEnter();
      reorder(orbs);
      dock.onMouseLeave(); // La salida del DOM: Windows y macOS.
      await hoverAfterTheGuard(hover);
      expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
    });

    // #264/S23: el bloqueo tras reordenar cubre un solo orbe, el que quedó
    // bajo el puntero al soltar. Con el puntero sobre otro orbe, ese otro
    // abre: reordenar un orbe no ciega la tira entera.
    // #264/S23: el bloqueo tras reordenar cubre el orbe que quedó bajo el
    // puntero, no la tira entera: otro orbe abre como siempre.
    it('does not block the other orbs after a reorder (#264/S23)', async () => {
      const { dock, enterB, orbs } = await wire();
      dock.onMouseEnter();
      reorder(orbs);
      await vi.advanceTimersByTimeAsync(500);
      enterB?.(orbElement as unknown as HTMLElement); // El hover del otro orbe.
      expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'b', anchored: false });
    });

    // #264/S28: el soltar quita la vista previa y aplica el orden nuevo, y eso
    // mueve los orbes debajo del puntero. La salida del orbe bloqueado que
    // provoca ese salto NO puede disolver el bloqueo: si lo disolviera, el
    // `enter` diferido abriría el detalle solo sobre el orbe soltado (#222).
    it('keeps the hold when the layout moves the orb at the drop (#264/S28, #222)', async () => {
      const { dock, hover, leave, orbs } = await wire(false, NO_PANEL);
      dock.onMouseEnter();
      reorder(orbs);
      leave?.(); // El salto de layout del soltar.
      await hoverAfterTheGuard(hover);
      await vi.advanceTimersByTimeAsync(400);
      expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
    });

    // #264/S30: soltar fuera de la tira no deja bloqueo. En Linux la salida
    // de la tira puede llegar antes que el `pointerup`, así que la presencia
    // ya está en `outside` y la regla de la transición no vuelve a disparar:
    // un bloqueo armado ahí no lo libera nadie.
    it('does not hold an orb when the drop lands outside the strip (#264/S30)', async () => {
      const { dock, hover, orbs } = await wire(false, NO_PANEL);
      dock.onMouseEnter();
      reorder(orbs, 5000); // El puntero suelta fuera de la ventana de la tira.
      await hoverAfterTheGuard(hover);
      // La apertura retardada del hover: sin bloqueo, el detalle abre.
      await vi.advanceTimersByTimeAsync(400);
      expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
    });

    // #264/S31: soltar en un hueco de la tira tampoco deja bloqueo: no hay
    // orbe bajo el puntero, así que no hay `enter` diferido que frenar.
    it('does not hold an orb when the drop lands on a gap (#264/S31)', async () => {
      const { dock, hover, orbs } = await wire(false, NO_PANEL);
      hitOrb.id = ''; // El puntero quedó sobre el fondo de la tira.
      dock.onMouseEnter();
      reorder(orbs);
      await hoverAfterTheGuard(hover);
      // La apertura retardada del hover: sin bloqueo, el detalle abre.
      await vi.advanceTimersByTimeAsync(400);
      expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
    });

    // #264/S23: el bloqueo se acaba cuando el puntero sale del orbe bloqueado
    // y vuelve a entrar en él.
    it('releases the hold when the pointer leaves the held orb and comes back (#264/S23)', async () => {
      const { hover, leave, orbs } = await wire(false, NO_PANEL);
      await vi.advanceTimersByTimeAsync(500);
      reorder(orbs);
      hover(orbElement as unknown as HTMLElement); // El enter del orbe bloqueado: no abre y lo confirma.
      await vi.advanceTimersByTimeAsync(400);
      expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
      leave?.(); // El puntero sale de ese orbe.
      await vi.advanceTimersByTimeAsync(500);
      hover(orbElement as unknown as HTMLElement); // Vuelve a entrar: ahora sí abre.
      await vi.advanceTimersByTimeAsync(400);
      expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
    });

    // #279: una cancelación no deja el bloqueo del reordenamiento puesto: no
    // hubo reordenamiento, así que el hover sigue abriendo. Antes la
    // cancelación pasaba por el handler de la suelta y armaba el bloqueo.
    it('does not block the hover after a cancelled drag (#279)', async () => {
      const { dock, hover, orbs } = await wire(false, NO_PANEL);
      dock.onMouseEnter();
      const orb = orbs.find((o) => o.id === 'a')!;
      const target = { setPointerCapture: () => {}, releasePointerCapture: () => {} };
      orb.onPointerDown({ button: 0, clientX: 10, clientY: 10, pointerId: 1, currentTarget: target });
      orb.onPointerMove({ clientX: 40, clientY: 10, pointerId: 1, currentTarget: target });
      orb.onPointerCancel?.({ pointerId: 1, currentTarget: target });
      await hoverAfterTheGuard(hover);
      // El hover con el panel cerrado espera el `OPEN_DELAY` antes de abrir.
      await vi.advanceTimersByTimeAsync(400);
      expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: false });
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
    area: { x: 0, y: 0, w: 1920, h: 1080 },
    sf: 1,
    monitor: null,
    screen: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  const report = (id: string) =>
    ({
      id,
      name: id,
      kind: 'subscription',
      status: 'ok',
      plan: null,
      meters: [],
      spend: null,
      message: null,
      action: null,
      fetchedAt: '2026-11-01T00:00:00Z',
    }) as unknown as UsageReport;

  /** Los orbes del markup: su id y su `order` de CSS, en el orden del DOM. */
  const orbs = (markup: string) =>
    [...markup.matchAll(/<button[^>]*class="orb eg-gauge"[^>]*>/g)].map((m) => ({
      id: m[0].match(/data-id="([^"]*)"/)?.[1],
      order: m[0].match(/style="([^"]*)"/)?.[1]?.match(/(?:^|;)\s*order:\s*(\d+)/)?.[1],
    }));

  // Hook slots of Widget (useDockReveal/useUpdaterMode are isolated above);
  // `useWidgetStartup` toma los tres primeros (0 config, 1 configFailed,
  // 2 configError). Después: 3 reports, 7 geo, 8 stripSize, 21 reorder.
  // Ref slots: 0 generation (useWidgetStartup), 7 orbsRef, 27 orbDrag.
  //
  // La vista previa se pasa como entrada del render; las pruebas no leen ese
  // slot por posición: lo buscan por su forma (#264/S32).
  const render = (reorder?: { id: string; order: string[] } | null) => {
    widgetEffects.stateIndex = 0;
    widgetEffects.refIndex = 0;
    widgetEffects.effects = [];
    widgetEffects.states[SLOT.config] = {
      providerOrder: ['a', 'b', 'c'],
      hiddenProviders: [],
      accounts: [],
      nineRouter: { baseUrl: '' },
      alerts: { threshold: 90 },
    };
    widgetEffects.states[SLOT.reports] = [report('a'), report('b'), report('c')];
    widgetEffects.states[SLOT.geo] = geo;
    widgetEffects.states[SLOT.stripSize] = { w: 400, h: 80 };
    widgetEffects.states[SLOT.dragging] = false;
    if (reorder !== undefined) widgetEffects.states[SLOT.reorder] = reorder;
    let tree: ReactNode = null;
    // biome-ignore lint/correctness/noComponentHookFactories: test harness component that captures the tree of a single render; it is never mounted by React.
    function CaptureWidget() {
      tree = Widget();
      return tree;
    }
    const markup = renderToStaticMarkup(createElement(CaptureWidget));
    return { markup, tree: tree! };
  };
  const markup = (reorder: { id: string; order: string[] } | null) => render(reorder).markup;

  /**
   * La vista previa del reordenamiento, encontrada por su forma y no por la
   * posición del hook: reordenar los hooks no puede romper la prueba
   * (#264/S32).
   */
  const preview = () =>
    widgetEffects.states.find(
      (s): s is { id: string; order: string[] } =>
        !!s && typeof s === 'object' && !Array.isArray(s) && typeof (s as { id?: unknown }).id === 'string' && Array.isArray((s as { order?: unknown }).order),
    );

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
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      innerWidth: 1920,
      innerHeight: 1080,
    });
    widgetEffects.patch.mockImplementation(async (patch: { providerOrder: string[] }) => ({
      accounts: [],
      nineRouter: { baseUrl: '' },
      ...patch,
    }));
    // La vista previa pone a 'b' al final: en pantalla el orden es a, c, b.
    const { tree } = render({ id: 'a', order: ['a', 'c', 'b'] });
    const dragged = findOrbPointers(tree).find((o) => o.id === 'a')!;
    // El DOM sigue el orden guardado (a, b, c) con las posiciones de la vista
    // previa: a en la ranura 0, c en la 1 y b en la 2.
    widgetEffects.refs[SLOT.orbsRef].current = {
      querySelectorAll: () => [
        { dataset: { id: 'a' }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 60, height: 60 }) },
        { dataset: { id: 'b' }, getBoundingClientRect: () => ({ left: 200, top: 0, width: 60, height: 60 }) },
        { dataset: { id: 'c' }, getBoundingClientRect: () => ({ left: 100, top: 0, width: 60, height: 60 }) },
      ],
    };
    dragged.onPointerDown({
      button: 0,
      clientX: 30,
      clientY: 30,
      pointerId: 1,
      currentTarget: { setPointerCapture: () => {} },
    });
    // El puntero cae entre 'c' (centro 130) y 'b' (centro 230).
    dragged.onPointerMove({ clientX: 150, clientY: 30 });
    // El estado visible de la vista previa: el `order` de CSS de cada orbe. El
    // DOM sigue en a, b, c y la vista previa los deja en c, a, b.
    const { tree: after, markup: previewed } = render();
    expect(orbs(previewed).map((o) => o.order)).toEqual(['1', '2', '0']);
    // Mover el puntero sólo cambia la vista previa: todavía no se persiste nada.
    expect(widgetEffects.patch).not.toHaveBeenCalled();

    // El gesto termina con el `onPointerUp` del orbe. Los handlers son
    // cierres del render que los creó, así que el que suelta tiene que ser el
    // del render nuevo, con la vista previa ya escrita.
    const dropped = findOrbPointers(after).find((o) => o.id === 'a')!;
    dropped.onPointerUp({
      clientX: 150,
      clientY: 30,
      pointerId: 1,
      currentTarget: { releasePointerCapture: () => {} },
    });
    // Lo que se guarda es el orden visual (c, a, b), no el del DOM (a, b, c).
    expect(widgetEffects.patch).toHaveBeenCalledTimes(1);
    expect(widgetEffects.patch).toHaveBeenCalledWith({ providerOrder: ['c', 'a', 'b'] });
    // Al soltar se limpia la vista previa: los orbes vuelven al orden guardado.
    expect(preview()).toBeUndefined();
    expect(orbs(render().markup).map((o) => o.order)).toEqual([undefined, undefined, undefined]);
  });

  // #279: cancelar el arrastre no confirma el reordenamiento. `pointercancel`
  // iba al mismo handler que `pointerup`, así que una cancelación del sistema
  // (pérdida de la captura, un gesto interrumpido, la ventana que pierde el
  // foco) guardaba el orden de la vista previa como definitivo.
  describe('a cancelled reorder does not confirm the order (#279)', () => {
    /** Los handlers de `keydown` que registró la tira. */
    const keydown: ((e: KeyboardEvent) => void)[] = [];

    beforeEach(() => {
      keydown.length = 0;
      // Las esperas del reloj (la ventana de 300 ms de la guarda, la apertura
      // retardada del hover) necesitan timers falsos.
      vi.useFakeTimers();
      vi.stubGlobal('window', {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 1920,
        innerHeight: 1080,
        // #279: Escape cancela el reordenamiento y la tira atiende el teclado
        // en la ventana, así que el arnés guarda el handler.
        addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
          if (type === 'keydown') keydown.push(fn);
        },
        removeEventListener: () => {},
      });
      widgetEffects.patch.mockImplementation(async (patch: { providerOrder: string[] }) => ({
        accounts: [],
        nineRouter: { baseUrl: '' },
        ...patch,
      }));
      // El hit-test del soltar (#264/S23): el puntero quedó sobre el orbe 'a',
      // así que el bloqueo del hover lo cubre y frena el `enter` diferido.
      vi.stubGlobal('document', {
        elementFromPoint: () => ({ closest: () => ({ getAttribute: () => 'a' }) }),
      });
    });

    /** La tira de tres orbes con las posiciones que decide la vista previa. */
    const strip = () => {
      widgetEffects.refs[SLOT.orbsRef].current = {
        querySelectorAll: () => [
          { dataset: { id: 'a' }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 60, height: 60 }) },
          { dataset: { id: 'b' }, getBoundingClientRect: () => ({ left: 200, top: 0, width: 60, height: 60 }) },
          { dataset: { id: 'c' }, getBoundingClientRect: () => ({ left: 100, top: 0, width: 60, height: 60 }) },
        ],
      };
    };

    /** Arrastra el orbe 'a': la vista previa queda escrita. */
    const drag = (tree: ReactNode) => {
      strip();
      const dragged = findOrbPointers(tree).find((o) => o.id === 'a')!;
      dragged.onPointerDown({
        button: 0,
        clientX: 30,
        clientY: 30,
        pointerId: 1,
        currentTarget: { setPointerCapture: () => {} },
      });
      dragged.onPointerMove({ clientX: 150, clientY: 30 });
      return dragged;
    };

    /** Escape, como lo atiende la tira. */
    const escapeKey = () => {
      const escapeEffect = widgetEffects.effects.find((e) => e.name === 'onEscapeKey');
      escapeEffect!.run();
      for (const h of keydown) h({ key: 'Escape' } as KeyboardEvent);
    };

    /** El orbe, para el anclaje por clic (#170/#223). */
    const orb = { getBoundingClientRect: () => ({ top: 0, left: 0, width: 60, height: 60 }) } as unknown as HTMLElement;

    // #279/S16: Escape con el botón todavía apretado. El gesto se cancela, pero
    // el botón sigue apretado y la captura puesta: al soltar llega el
    // `pointerup` y el navegador despacha el `click` de la cola sobre el mismo
    // orbe. Si el gesto no quedó marcado como cancelado, ese `click` ancla el
    // panel en el orbe que el usuario quería mover.
    it('does not anchor the panel when Escape is pressed with the button still down (#279/S16)', () => {
      const { tree } = render(null);
      const dragged = drag(tree);
      expect(widgetEffects.states[SLOT.reorder]).not.toBeNull();
      escapeKey();
      expect(widgetEffects.states[SLOT.reorder]).toBeNull();
      // El usuario suelta.
      dragged.onPointerUp({
        clientX: 150,
        clientY: 30,
        pointerId: 1,
        currentTarget: { releasePointerCapture: () => {} },
      });
      // Y el navegador despacha el `click` de la cola sobre el mismo orbe.
      dragged.onClick?.(orb);
      expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
      expect(widgetEffects.patch).not.toHaveBeenCalled();
    });

    // Un clic normal (sin arrastrar) sigue anclando el panel (#170/#223): lo
    // garantiza la compuerta `od.moved` (#279/S18).
    it('still anchors the panel on a plain click (#170/#223)', () => {
      const { tree } = render(null);
      const plain = findOrbPointers(tree).find((o) => o.id === 'a')!;
      plain.onPointerDown({
        button: 0,
        clientX: 30,
        clientY: 30,
        pointerId: 1,
        currentTarget: { setPointerCapture: () => {} },
      });
      plain.onPointerUp({
        clientX: 30,
        clientY: 30,
        pointerId: 1,
        currentTarget: { releasePointerCapture: () => {} },
      });
      plain.onClick?.(orb);
      expect(widgetEffects.states[SLOT.panel]).toEqual({ providerId: 'a', anchored: true });
    });

    // El `enter` diferido del navegador no abre el detalle: para eso está el
    // bloqueo del hover. El reloj pasa la ventana de 300 ms de la suelta, si
    // no esa guarda taparía al bloqueo y el test no discriminaría (#279/S16).
    it('does not open the detail on the deferred enter after a cancelled drag (#279/S16)', async () => {
      const { tree } = render(null);
      const dragged = drag(tree);
      escapeKey();
      dragged.onPointerUp({
        clientX: 150,
        clientY: 30,
        pointerId: 1,
        currentTarget: { releasePointerCapture: () => {} },
      });
      await vi.advanceTimersByTimeAsync(400);
      findOrbHover(tree)?.(orb);
      await vi.advanceTimersByTimeAsync(400);
      expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
    });

    // La ventana entre el Escape y la suelta: el gesto sigue vivo (el botón
    // apretado), así que el hover no puede abrir el detalle (#279/S16).
    it('does not open the detail between Escape and the release (#279/S16)', async () => {
      const { tree } = render(null);
      drag(tree);
      escapeKey();
      await vi.advanceTimersByTimeAsync(400);
      findOrbHover(tree)?.(orb);
      await vi.advanceTimersByTimeAsync(400);
      expect(widgetEffects.states[SLOT.panel]).toEqual(NO_PANEL);
    });

    // Después del Escape el gesto cancelado no mueve más la vista previa: si
    // moviera, se vería un reordenamiento que nunca se guarda (#279/S16).
    it('does not move the preview after Escape cancels the drag (#279/S16)', () => {
      const { tree } = render(null);
      const dragged = drag(tree);
      escapeKey();
      expect(widgetEffects.states[SLOT.reorder]).toBeNull();
      dragged.onPointerMove({ clientX: 200, clientY: 30 });
      expect(widgetEffects.states[SLOT.reorder]).toBeNull();
    });

    // Un `pointercancel` durante el arrastre deja el orden guardado sin cambios.
    it('does not save the order when the drag is cancelled (#279)', () => {
      const { tree } = render(null);
      const dragged = drag(tree);
      expect(widgetEffects.states[SLOT.reorder]).not.toBeNull();
      dragged.onPointerCancel?.({
        pointerId: 1,
        currentTarget: { releasePointerCapture: () => {} },
      });
      expect(widgetEffects.patch).not.toHaveBeenCalled();
      expect(widgetEffects.states[SLOT.reorder]).toBeNull();
    });

    // Escape durante el arrastre restaura el orden original.
    it('does not save the order when Escape cancels the drag (#279)', () => {
      const { tree } = render(null);
      drag(tree);
      expect(widgetEffects.states[SLOT.reorder]).not.toBeNull();
      // El efecto se busca por nombre (#279/S19): el texto de su fuente se
      // rompe con cualquier refactor. Y el handler es el que registró la
      // tira, que el arnés intercepta (#279).
      const escapeEffect = widgetEffects.effects.find((e) => e.name === 'onEscapeKey');
      escapeEffect!.run();
      for (const h of keydown) h({ key: 'Escape' } as KeyboardEvent);
      expect(widgetEffects.patch).not.toHaveBeenCalled();
      expect(widgetEffects.states[SLOT.reorder]).toBeNull();
    });

    // Soltar normalmente sigue guardando el nuevo orden: la separación de la
    // cancelación no puede romper la suelta.
    it('still saves the order when the orb is dropped (#279)', () => {
      const { tree } = render(null);
      drag(tree);
      const preview = widgetEffects.states[SLOT.reorder] as { id: string; order: string[] };
      // Los handlers son cierres del render que los creó: el que suelta tiene
      // que ser el del render nuevo, con la vista previa ya escrita.
      const { tree: after } = render(preview);
      const dropped = findOrbPointers(after).find((o) => o.id === 'a')!;
      dropped.onPointerUp({
        clientX: 150,
        clientY: 30,
        pointerId: 1,
        currentTarget: { releasePointerCapture: () => {} },
      });
      expect(widgetEffects.patch).toHaveBeenCalledTimes(1);
      expect(widgetEffects.patch).toHaveBeenCalledWith({ providerOrder: preview.order });
      expect(widgetEffects.states[SLOT.reorder]).toBeNull();
    });
  });
});
