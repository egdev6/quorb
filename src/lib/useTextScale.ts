import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { settleTextScale } from './text-scale';

/** Wait after a scale change so the WebView ratio and the monitor scale settle together. */
const SETTLE_MS = 150;

/**
 * Text scale of the current window (#228). Starts at 1 and is re-read whenever the
 * WebView ratio or the monitor scale changes, after the change has settled; a
 * reading that moved meanwhile, or that Windows cannot produce, keeps the last
 * valid value (#228, S4).
 */
export function useTextScale(): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    let disposed = false;
    let timer = 0;
    let query: MediaQueryList | null = null;
    let unlisten: (() => void) | null = null;

    const read = async () => {
      const dprBefore = window.devicePixelRatio;
      const sf = await getCurrentWindow().scaleFactor();
      if (disposed) return;
      const sample = { dprBefore, sf, dprAfter: window.devicePixelRatio };
      setScale((previous) => settleTextScale(previous, sample));
      // The ratio moved while the scale was read: read again once it settles.
      if (sample.dprAfter !== dprBefore) schedule();
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { read().catch(() => {}); }, SETTLE_MS);
    };
    // A resolution query matches one exact ratio: re-arm it after every change.
    const arm = () => {
      query?.removeEventListener('change', onChange);
      if (typeof window.matchMedia !== 'function' || !window.devicePixelRatio) return;
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      query.addEventListener('change', onChange);
    };
    const onChange = () => {
      if (disposed) return;
      arm();
      schedule();
    };

    arm();
    read().catch(() => {});
    getCurrentWindow()
      .onScaleChanged(onChange)
      .then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch(() => {});
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      query?.removeEventListener('change', onChange);
      unlisten?.();
    };
  }, []);
  return scale;
}
