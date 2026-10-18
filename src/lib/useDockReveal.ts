import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { finishReveal, readyReveal, requestReveal, PEEK_FADE_DURATION, REVEAL_FALLBACK, type RevealPhase } from './auto-hide';

export function useDockReveal(hidden: boolean) {
  const [phase, setPhase] = useState<RevealPhase>('open');
  useLayoutEffect(() => { setPhase((p) => requestReveal(p, hidden)); }, [hidden]);
  useEffect(() => {
    if (phase !== 'opening' && phase !== 'closing' && phase !== 'leaving-handle') return;
    const fallback = phase === 'leaving-handle' ? PEEK_FADE_DURATION + 80 : REVEAL_FALLBACK;
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : fallback;
    const timer = window.setTimeout(() => setPhase((p) => p === phase ? finishReveal(p) : p), delay);
    return () => window.clearTimeout(timer);
  }, [phase]);
  const markPrepared = useCallback((preparedPhase: RevealPhase) => setPhase((p) => p === preparedPhase ? readyReveal(p) : p), []);
  const finishTransition = useCallback(() => setPhase(finishReveal), []);
  return { phase, markPrepared, finishTransition };
}
