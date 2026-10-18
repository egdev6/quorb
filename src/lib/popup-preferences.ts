import type { Meter, UsageReport } from './types';
import { meterColor } from './meter-colors';

const isHourly = (m: Meter) => m.windowSeconds != null && m.windowSeconds > 0 && m.windowSeconds < 86400;
const isWeekly = (m: Meter) => m.windowSeconds != null && m.windowSeconds >= 604800 && m.windowSeconds < 1209600;

/** Popup-only period colors; never override shared ring variables or the widget palette. */
export function popupMeterColor(report: UsageReport, meter: Meter, index: number): string {
  const percentages = report.meters.filter(m => m.percent != null);
  if (report.kind === 'subscription' && meter.percent != null
    && percentages.some(isHourly) && percentages.some(isWeekly)) {
    if (isHourly(meter)) return '#ffffff';
    if (isWeekly(meter)) return 'var(--popup-primary, #ff0036)';
  }
  return meterColor(report, meter, index);
}

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
