import type { UsageReport } from './types';
import { providerOf } from './accounts';

/** Provider-specific note for each provider that reports a banked reset balance. */
const RESET_NOTE: Record<string, string> = {
  codex: 'saldo comunicado por Codex; no son reinicios automáticos',
  zai: 'saldo comunicado por z.ai; cada reset vence y se usa manualmente',
};

/** Only the server's banked balance is authoritative; dates and quotas are unrelated. */
export function resetCreditsInfo(report: UsageReport) {
  const count = report.availableResets;
  const note = RESET_NOTE[providerOf(report.id)];
  if (note === undefined || report.stale || !['ok', 'warning'].includes(report.status)) return null;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 4294967295) return null;
  const label = count === 1 ? '1 reset disponible' : `${count} resets disponibles`;
  return { count, label, title: `${label} · ${note}` };
}
