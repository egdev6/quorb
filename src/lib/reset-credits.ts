import type { UsageReport } from './types';
import { providerOf } from './accounts';

/** Only the server's banked balance is authoritative; dates and quotas are unrelated. */
export function resetCreditsInfo(report: UsageReport) {
  const count = report.availableResets;
  if (providerOf(report.id) !== 'codex' || report.stale || !['ok', 'warning'].includes(report.status)) return null;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 4294967295) return null;
  const label = count === 1 ? '1 reset disponible' : `${count} resets disponibles`;
  return { count, label, title: `${label} · saldo comunicado por Codex; no son reinicios automáticos` };
}
