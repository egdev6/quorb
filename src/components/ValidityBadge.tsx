import type { Locale, UsageReport } from '../lib/types';
import { validityInfo } from '../lib/validity';
import { resetCreditsInfo } from '../lib/reset-credits';

function ResetIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5" /></svg>;
}

/** Independent provider dates and banked balances; compact mode uses a single chip. */
export function ValidityBadge({ report, compact = false, showResets = true, locale = 'es' }: { report: UsageReport; compact?: boolean; showResets?: boolean; locale?: Locale }) {
  const validity = validityInfo(report, locale);
  const resets = !compact || showResets ? resetCreditsInfo(report, locale) : null;
  if (compact && resets) {
    const title = [validity?.title, resets.title].filter(Boolean).join(' · ');
    return (
      <span className="q-validity q-validity--compact" data-kind="resets" title={title} aria-hidden="true">
        <ResetIcon /><span>{resets.count > 99 ? '99+' : resets.count}</span>
      </span>
    );
  }
  if (!validity && !resets) return null;
  return (
    <>
      {validity && <span className={`q-validity${compact ? ' q-validity--compact' : ''}`} data-kind={validity.kind} title={validity.title} aria-hidden={compact || undefined}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {validity.kind === 'key'
            ? <path d="M15 7a5 5 0 1 0 2 9l4 4 2-2-4-4a5 5 0 0 0-4-7ZM12 11h.01" />
            : <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18M8 15h3" /></>}
        </svg>
        {!compact && <span>{validity.label} <time dateTime={validity.at}>{validity.formatted}</time></span>}
      </span>}
      {!compact && resets && <span className="q-validity" data-kind="resets" title={resets.title}>
        <ResetIcon />
        <span>{resets.label}</span>
      </span>}
    </>
  );
}
