import { samePhysical, type PhysicalBounds } from './detail-panel';

export interface RecoverySnapshot {
  bounds: PhysicalBounds;
  monitors: PhysicalBounds[];
  visible: boolean;
  minimized: boolean;
  expected?: PhysicalBounds | null;
}

interface RecoveryDependencies {
  allowed: () => boolean;
  read: () => Promise<RecoverySnapshot>;
  recover: (snapshot: RecoverySnapshot) => Promise<void>;
  expected?: () => PhysicalBounds | null;
}

function valid(bounds: PhysicalBounds): boolean {
  return [bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite)
    && bounds.w > 0 && bounds.h > 0;
}

function overlaps(a: PhysicalBounds, b: PhysicalBounds): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x
    && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Check native reality, not the last successfully requested rectangle.
 * Hidden/minimized windows belong to the user; incomplete monitor reads are not
 * evidence of displacement. Never overlap ticks or revive stale drag/unmount work.
 */
export function createWidgetRecovery(deps: RecoveryDependencies): () => Promise<void> {
  let checking = false;
  return async () => {
    if (checking || !deps.allowed()) return;
    checking = true;
    try {
      const state = await deps.read();
      if (!deps.allowed() || !state.visible || state.minimized || !valid(state.bounds)
        || !state.monitors.length || !state.monitors.every(valid)) return;
      if (state.expected && (!valid(state.expected)
        || (deps.expected && !samePhysical(deps.expected(), state.expected)))) return;
      const wrongSize = state.expected && (Math.abs(state.bounds.w - state.expected.w) > 1
        || Math.abs(state.bounds.h - state.expected.h) > 1);
      if (wrongSize || !state.monitors.some((monitor) => overlaps(state.bounds, monitor))) {
        await deps.recover(state);
      }
    } catch {
      // A transient native/API failure must not move the window or stop later ticks.
    } finally {
      checking = false;
    }
  };
}
