import widget from '../Widget.tsx?raw';
import { Widget } from '../Widget';
import { createElement, isValidElement, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import hook from './useDockReveal.ts?raw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finishReveal, peekRect, readyReveal, requestReveal, usesPeekWindow, waitForViewport, watchPreparation, REVEAL_DURATION, type RevealPhase } from './auto-hide';
import { resetDragMode, setDragMode } from './drag-session';
import { contains, stripRect, type Edge } from './dock';

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

// Capture the real Widget effect callbacks while SSR supplies its hook scope.
// No DOM renderer, Tauri runtime, or native-order assumptions are involved.
const widgetEffects = vi.hoisted(() => ({
  states: [] as unknown[], stateIndex: 0,
  refs: [] as { current: unknown }[], refIndex: 0,
  effects: [] as { run: () => void | (() => void); deps?: readonly unknown[] }[],
  bounds: vi.fn(), clip: vi.fn(), show: vi.fn(), innerSize: vi.fn(),
  outerPosition: vi.fn(), setPosition: vi.fn(), monitors: vi.fn(), patch: vi.fn(), stateWrite: vi.fn(),
  cancel: vi.fn(async () => {}),
  listeners: new Map<string, (() => void)[]>(),
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
  useDockReveal: () => ({ phase: 'open', markPrepared: vi.fn(), finishTransition: vi.fn() }),
}));
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
  listen: vi.fn(async (name: string, handler: () => void) => {
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
    expect(widget).toContain('usesPeekWindow(phase) ? peekRect(s, edge) : s');
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
  const renderWidget = (dragging: boolean, autoHide = false) => {
    // Hook slots belong to Widget (useDockReveal/useUpdaterMode are isolated above).
    widgetEffects.states[0] = autoHide ? { autoHide, accounts: [], nineRouter: { baseUrl: '' } } : null;
    widgetEffects.states[5] = geo;
    widgetEffects.states[6] = { w: 400, h: 80 };
    widgetEffects.states[9] = dragging;
    return commitWidget();
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
    resetDragMode();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  const dragFixture = () => {
    configureNative();
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
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 16, height: 80 }),
    };
    const pointer = (screenY: number, pointerId = 7) => ({
      button: 0, pointerId, screenX: 768, screenY, currentTarget: target,
      target: { closest: () => target }, preventDefault: vi.fn(),
    }) as unknown as ReactPointerEvent<HTMLSpanElement>;
    const { grip } = renderWidget(false);
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
