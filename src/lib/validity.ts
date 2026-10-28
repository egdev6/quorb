import type { Locale, UsageReport } from './types';
import { intlLocale, t } from '../i18n';

/** Provider RFC3339 dates only: JS otherwise normalizes impossible days (e.g. Feb 30). */
function validDate(at: string): Date | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(at);
  if (!parts) return null;
  const [, year, month, day] = parts.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** No fallback dates: billing period end is not confirmed cancellation. */
export function validityInfo(report: UsageReport, locale: Locale = 'es') {
  const validity = report.validity;
  if (!validity || report.stale || !['ok', 'warning'].includes(report.status)) return null;
  const date = validDate(validity.at);
  if (!date || !['period', 'key'].includes(validity.kind)) return null;
  const label = t(locale, validity.kind === 'key' ? 'details.validity.keyLabel' : 'details.validity.periodLabel');
  const formatted = date.toLocaleDateString(intlLocale(locale), { day: 'numeric', month: 'short', year: 'numeric' });
  const note = t(locale, validity.kind === 'period' ? 'details.validity.periodNote' : 'details.validity.keyNote');
  const title = `${label} ${formatted} · ${note}`;
  return { ...validity, label, formatted, title };
}
