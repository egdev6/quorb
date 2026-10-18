import { isVertical, type Edge, type Rect } from './dock';

export const REVEAL_DURATION = 280;
export const PEEK_FADE_DURATION = 120;
export const REVEAL_FALLBACK = REVEAL_DURATION + 80;
export type RevealPhase = 'hidden' | 'leaving-handle' | 'preparing' | 'opening' | 'open' | 'closing' | 'settling';

/** Never resize a viewport while its handle is painted. */
export function requestReveal(phase: RevealPhase, hidden: boolean): RevealPhase {
  if (hidden) {
    if (phase === 'hidden' || phase === 'settling') return phase;
    return phase === 'preparing' || phase === 'leaving-handle' ? 'settling' : 'closing';
  }
  if (phase === 'hidden') return 'leaving-handle';
  if (phase === 'settling') return 'preparing';
  return phase === 'closing' ? 'opening' : phase;
}

export function readyReveal(phase: RevealPhase): RevealPhase {
  if (phase === 'preparing') return 'opening';
  return phase === 'settling' ? 'hidden' : phase;
}

export function finishReveal(phase: RevealPhase): RevealPhase {
  if (phase === 'leaving-handle') return 'preparing';
  if (phase === 'opening') return 'open';
  return phase === 'closing' ? 'settling' : phase;
}

export const usesPeekWindow = (phase: RevealPhase) => phase === 'hidden' || phase === 'leaving-handle' || phase === 'settling';

/** Surface stalled preparation as a recoverable error, never guess that native geometry succeeded. */
export function watchPreparation(phase: RevealPhase, onStalled: () => void): () => void {
  if (phase !== 'preparing' && phase !== 'settling') return () => {};
  const timer = window.setTimeout(onStalled, 1500);
  return () => window.clearTimeout(timer);
}

/** A Tauri bounds reply can precede WebView layout. The timeout avoids an occluded-window RAF deadlock. */
export function waitForViewport(): Promise<void> {
  return new Promise((resolve) => {
    let frame = 0;
    const finish = () => { window.clearTimeout(timer); window.cancelAnimationFrame(frame); resolve(); };
    const timer = window.setTimeout(finish, 120);
    frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(finish); });
  });
}

/** Same center in either window size, so the handle never jumps while resizing. */
export function peekRect(strip: Rect, edge: Edge): Rect {
  const vertical = isVertical(edge);
  const span = Math.min(48, vertical ? strip.h : strip.w);
  const depth = Math.min(24, vertical ? strip.w : strip.h);
  if (vertical) return { x: edge === 'left' ? strip.x : strip.x + strip.w - depth, y: strip.y + (strip.h - span) / 2, w: depth, h: span };
  return { x: strip.x + (strip.w - span) / 2, y: edge === 'top' ? strip.y : strip.y + strip.h - depth, w: span, h: depth };
}
