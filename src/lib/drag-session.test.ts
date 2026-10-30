import { beforeEach, describe, expect, it } from 'vitest';
import { currentDragMode, dragMode, fallbackDragMode, resetDragMode, setDragMode } from './drag-session';

describe('dragMode', () => {
  it('decides by effective GDK backend, not session type', () => {
    // The maintainer-required case for #180: a Wayland session forced to
    // GDK_BACKEND=x11 reports displayBackend 'x11' from get_wm_info, and the
    // decision layer must treat it as native (snap + persistence keep working
    // under XWayland). The session + override combination itself is covered by
    // the Rust integration test in src-tauri/src/wm_compat.rs.
    expect(dragMode('x11')).toEqual({
      mode: 'native',
      allowSnap: true,
      allowPersist: true,
    });
    // Native GDK Wayland display: the compositor moves the window, so neither
    // snap nor persistence is possible (see rationale in drag-session.ts).
    expect(dragMode('wayland')).toEqual({
      mode: 'compositor',
      allowSnap: false,
      allowPersist: false,
    });
  });

  it.each([
    ['x11', 'native', true, true],
    ['wayland', 'compositor', false, false],
  ] as const)('keeps decision invariants for %s', (backend, mode, snap, persist) => {
    const decision = dragMode(backend);
    expect(decision.mode).toBe(mode);
    expect(decision.allowSnap).toBe(decision.mode === 'native');
    expect(decision.allowPersist).toBe(snap);
    expect(decision.allowPersist).toBe(persist);
  });
});

describe('fallbackDragMode (detection failure, #180 review minor)', () => {
  // The maintainer review of #210: if `get_wm_info` fails, the 'compositor'
  // degradation must not reach Windows/macOS, where a one-off probe failure
  // would silently remove the only drag the platform has (the magnet). Linux
  // keeps the no-touch gesture because the native pipeline could corrupt
  // config.json in unknown conditions.
  it('degrades to compositor on Linux only', () => {
    expect(fallbackDragMode('linux')).toBe('compositor');
    expect(fallbackDragMode('windows')).toBe('native');
    expect(fallbackDragMode('macos')).toBe('native');
  });
});

describe('module decision store', () => {
  // The store is module-global, so every test starts from the unresolved
  // default to stay independent of execution order.
  beforeEach(() => {
    resetDragMode();
  });

  it('starts unresolved: currentDragMode() is null and the grip would be blocked', () => {
    expect(currentDragMode()).toBeNull();
  });

  it('records the mount-effect decision', () => {
    setDragMode(dragMode('x11').mode);
    expect(currentDragMode()).toBe('native');
    setDragMode(dragMode('wayland').mode);
    expect(currentDragMode()).toBe('compositor');
    setDragMode('compositor'); // Detection-failure fallback path.
    expect(currentDragMode()).toBe('compositor');
  });

  it('resetDragMode returns to the unresolved state', () => {
    setDragMode('native');
    expect(currentDragMode()).toBe('native');
    resetDragMode();
    expect(currentDragMode()).toBeNull();
  });

  it('is pure with respect to dragMode(): the decision function stays stateless', () => {
    setDragMode('compositor');
    expect(dragMode('x11')).toEqual(dragMode('x11'));
    expect(dragMode('x11').mode).toBe('native');
    expect(dragMode('wayland').mode).toBe('compositor');
    expect(currentDragMode()).toBe('compositor');
  });
});
