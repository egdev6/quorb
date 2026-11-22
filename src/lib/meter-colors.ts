import type { Meter, UsageReport } from './types';
import { providerOf } from './accounts';

/** Live palette: Claude/Codex use quota periods; model/API providers keep ring order. */
export function meterColor(report: UsageReport, meter: Meter, index: number): string {
  const provider = providerOf(report.id);
  if (provider !== 'claude' && provider !== 'codex') return `var(--ring-${(index % 3) + 1})`;

  const seconds = meter.windowSeconds;
  if (seconds != null && seconds > 0) {
    if (seconds >= 6 * 86400 && seconds <= 8 * 86400) return 'var(--ring-1)';
    return seconds < 86400 ? 'var(--ring-2)' : 'var(--ring-3)';
  }
  // Without duration metadata the stable meter id says which period this is (codex may suffix it).
  if (meter.id) {
    if (meter.id === 'session' || meter.id.startsWith('session_')) return 'var(--ring-2)';
    if (meter.id === 'weekly' || meter.id.startsWith('weekly_')) return 'var(--ring-1)';
    return 'var(--ring-3)';
  }
  // Last resort for older reports without an id: the provider's period label.
  if (/^semana\b/i.test(meter.label)) return 'var(--ring-1)';
  if (/^sesión\b/i.test(meter.label)) return 'var(--ring-2)';
  return 'var(--ring-3)';
}
