import type { CSSProperties } from 'react';
import type { UsageReport } from './types';

export function disclosureOpen(provider: string, section: 'pace' | 'history'): boolean {
  try {
    const stored = localStorage.getItem(`popup:${provider}:${section}`);
    if (stored === 'true' || stored === 'false') return stored === 'true';
  } catch { /* Storage may be unavailable. */ }
  return section === 'pace';
}

export function saveDisclosure(provider: string, section: 'pace' | 'history', open: boolean): void {
  try { localStorage.setItem(`popup:${provider}:${section}`, String(open)); }
  catch { /* Keep native disclosures usable without storage. */ }
}

/** Popup only: short sessions are white, weekly windows use the accent. */
export function popupRingStyle(report: UsageReport): CSSProperties | undefined {
  const meters = report.meters.filter((m) => m.percent != null);
  const isHourly = (seconds: number | null) => seconds != null && seconds > 0 && seconds < 86400;
  const isWeekly = (seconds: number | null) => seconds != null && seconds >= 604800 && seconds < 1209600;
  if (report.kind !== 'subscription' || !meters.some((m) => isHourly(m.windowSeconds)) || !meters.some((m) => isWeekly(m.windowSeconds))) return undefined;
  const colors: Record<string, string> = {};
  meters.slice(0, 3).forEach((m, i) => {
    if (isHourly(m.windowSeconds)) colors[`--ring-${i + 1}`] = '#ffffff';
    else if (isWeekly(m.windowSeconds)) colors[`--ring-${i + 1}`] = 'var(--popup-primary, #ff0036)';
  });
  return colors as CSSProperties;
}
