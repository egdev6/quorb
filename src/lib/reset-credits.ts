import type { Locale, UsageReport } from './types';
import { providerOf } from './accounts';
import { t, type MessageKey } from '../i18n';

/** Catalog key of the provider-specific note for each provider that reports a banked reset balance. */
const RESET_NOTE_KEY: Record<string, MessageKey> = {
  codex: 'details.resets.codexNote',
  zai: 'details.resets.zaiNote',
};

/** Only the server's banked balance is authoritative; dates and quotas are unrelated. */
export function resetCreditsInfo(report: UsageReport, locale: Locale = 'es') {
  const count = report.availableResets;
  const noteKey = RESET_NOTE_KEY[providerOf(report.id)];
  if (noteKey === undefined || report.stale || !['ok', 'warning'].includes(report.status)) return null;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 4294967295) return null;
  const label = count === 1 ? t(locale, 'details.resets.one') : t(locale, 'details.resets.many', { count });
  return { count, label, title: `${label} · ${t(locale, noteKey)}` };
}
