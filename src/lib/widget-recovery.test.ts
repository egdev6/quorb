import { describe, expect, it, vi } from 'vitest';
import { createWidgetRecovery, shouldAuditNativePosition, type RecoverySnapshot } from './widget-recovery';

const primary = { x: 0, y: 0, w: 4096, h: 1152 };
function snapshot(over: Partial<RecoverySnapshot> = {}): RecoverySnapshot {
  return {
    bounds: { x: -32000, y: -32000, w: 199, h: 34 },
    monitors: [primary], visible: true, minimized: false, ...over,
  };
}
function setup(state = snapshot()) {
  const read = vi.fn(async () => state);
  const recover = vi.fn(async () => {});
  const allowed = vi.fn(() => true);
  const expected = vi.fn(() => state.expected ?? null);
  const check = createWidgetRecovery({ read, recover, allowed, expected });
  return { read, recover, allowed, expected, check };
}

describe('widget off-screen recovery', () => {
  it('recovers the observed sentinel even when the cached dock target has not changed', async () => {
    const s = setup(snapshot({ expected: { x: 0, y: 0, w: 199, h: 34 } }));
    await s.check();
    expect(s.recover).toHaveBeenCalledOnce();
  });

  it.each([
    { x: 20, y: 20, w: 200, h: 60 },
    { x: -199, y: 20, w: 200, h: 60 }, // One visible pixel is enough.
    { x: 4095, y: 20, w: 200, h: 60 },
  ])('leaves visible/partially visible windows alone: %j', async (bounds) => {
    const s = setup(snapshot({ bounds, expected: { x: 0, y: 0, w: 200, h: 60 } }));
    await s.check();
    await s.check();
    expect(s.recover).not.toHaveBeenCalled();
  });

  it.each([
    [199, 34, true], [389, 100, false], [388, 101, false], [390, 99, false],
    [387, 100, true], [389, 102, true],
  ])('compares overlapping native size %sx%s with the physical target', async (w, h, damaged) => {
    const expected = { x: 4731, y: 1280, w: 389, h: 100 };
    const s = setup(snapshot({ bounds: { x: 4921, y: 1346, w, h },
      monitors: [{ x: 0, y: 0, w: 5120, h: 1380 }], expected }));
    await s.check();
    expect(s.recover).toHaveBeenCalledTimes(damaged ? 1 : 0);
  });

  it('discards expected geometry changed during a native read', async () => {
    const s = setup(snapshot({ expected: { x: 0, y: 0, w: 389, h: 100 } }));
    let finish!: (state: RecoverySnapshot) => void;
    s.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = s.check();
    s.expected.mockReturnValue({ x: 1, y: 0, w: 389, h: 100 });
    finish(snapshot({ expected: { x: 0, y: 0, w: 389, h: 100 } }));
    await pending;
    expect(s.recover).not.toHaveBeenCalled();
  });

  it('accepts negative coordinates on another monitor and mixed physical DPI sizes', async () => {
    const s = setup(snapshot({
      bounds: { x: -1400, y: -500, w: 248, h: 63 },
      expected: { x: 0, y: 0, w: 248, h: 63 },
      monitors: [primary, { x: -1440, y: -588, w: 1152, h: 2048 }],
    }));
    await s.check();
    expect(s.recover).not.toHaveBeenCalled();
  });

  it.each([{ visible: false }, { minimized: true }, { monitors: [] },
    { expected: { x: 0, y: 0, w: 0, h: 100 } },
    { expected: { x: 0, y: 0, w: NaN, h: 100 } },
    { bounds: { x: NaN, y: 0, w: 199, h: 34 } },
    { bounds: { x: -32000, y: -32000, w: 0, h: 34 } },
  ])('does not move hidden/minimized windows or act on invalid snapshots: %j', async (over) => {
    const s = setup(snapshot(over));
    await s.check();
    expect(s.recover).not.toHaveBeenCalled();
  });

  it('skips reads while dragging, unmounted or placement is not ready', async () => {
    const s = setup();
    s.allowed.mockReturnValue(false);
    await s.check();
    expect(s.read).not.toHaveBeenCalled();
  });

  it('discards a stale read and prevents overlapping checks', async () => {
    const s = setup();
    let finish!: (state: RecoverySnapshot) => void;
    s.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = s.check();
    await s.check();
    expect(s.read).toHaveBeenCalledOnce();
    s.allowed.mockReturnValue(false);
    finish(snapshot());
    await pending;
    expect(s.recover).not.toHaveBeenCalled();
  });

  it('tolerates transient API errors and checks again on the next tick', async () => {
    const s = setup();
    s.read.mockRejectedValueOnce(new Error('monitor unavailable'));
    await expect(s.check()).resolves.toBeUndefined();
    await s.check();
    expect(s.recover).toHaveBeenCalledOnce();
  });

  it('contains recovery errors without disabling subsequent checks', async () => {
    const s = setup();
    s.recover.mockRejectedValueOnce(new Error('window unavailable'));
    await expect(s.check()).resolves.toBeUndefined();
    await s.check();
    expect(s.recover).toHaveBeenCalledTimes(2);
  });
});

describe('shouldAuditNativePosition', () => {
  const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
  const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15';

  it('solo audita en Windows: en Linux el recovery seria un falso positivo estructural', () => {
    // Wayland xdg-shell devuelve outerPosition() === (0,0) por diseño y GTK
    // dimensiona distinto, asi que cada tick «corregiria» una ventana sana (#148).
    expect(shouldAuditNativePosition('windows')).toBe(true);
    expect(shouldAuditNativePosition('macos')).toBe(false);
    expect(shouldAuditNativePosition('linux')).toBe(false);
  });

  it('preserva exactamente el gate que sustituye: /Windows/.test(ua)', () => {
    expect(shouldAuditNativePosition('windows')).toBe(/Windows/.test(WINDOWS_UA));
    expect(shouldAuditNativePosition('macos')).toBe(/Windows/.test(MAC_UA));
    expect(shouldAuditNativePosition('linux')).toBe(/Windows/.test(LINUX_UA));
  });

  // #180 (WU3, regression pin): the widget now branches drag strategies by
  // display backend (WU2), but the position audit must stay Windows-only.
  // Under native Wayland the compositor owns placement (WU2/compositor branch)
  // and outerPosition() is (0,0) by design, so auditing would fight the
  // compositor's placement; under XWayland the audit gate must NOT reactivate
  // either, keeping the pre-#180 behavior (Linux excluded) intact.
  it('#180 regression: la auditoria no se reactiva con la rama de arrastre por compositor', () => {
    expect(shouldAuditNativePosition('linux')).toBe(false);
  });
});
