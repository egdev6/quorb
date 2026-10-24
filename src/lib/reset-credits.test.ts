import { describe, expect, it } from 'vitest';
import type { UsageReport } from './types';
import { resetCreditsInfo } from './reset-credits';

const report: UsageReport = {
  id: 'codex:work', name: 'Codex · Trabajo', kind: 'subscription', status: 'ok', plan: null,
  meters: [], spend: null, message: null, action: null, fetchedAt: '2030-01-01T00:00:00Z',
};
const banked = (count: unknown): UsageReport & { availableResets: number } => ({
  ...report, availableResets: count as number,
});

describe('server-reported Codex reset credits', () => {
  it.each([[0, '0 resets disponibles'], [1, '1 reset disponible'], [2, '2 resets disponibles'],
    [4294967295, '4294967295 resets disponibles']])('shows the balance %s without dates or meters', (count, label) => {
    expect(resetCreditsInfo(banked(count))).toMatchObject({ count, label });
    expect(resetCreditsInfo(banked(count))?.title).toContain('saldo comunicado por Codex; no son reinicios automáticos');
  });

  it.each([null, undefined, -1, 0.5, true, '2', NaN, Infinity, -Infinity, 4294967296, Number.MAX_SAFE_INTEGER + 1])(
    'hides unknown or invalid count %s rather than assuming zero', (count) => {
      expect(resetCreditsInfo(banked(count))).toBeNull();
    },
  );

  it('accepts fresh warning data but hides stale and unsuccessful reports', () => {
    expect(resetCreditsInfo({ ...banked(2), status: 'warning' })?.count).toBe(2);
    expect(resetCreditsInfo({ ...banked(2), stale: true })).toBeNull();
    for (const status of ['error', 'needsLogin', 'unconfigured'] as const) {
      expect(resetCreditsInfo({ ...banked(2), status })).toBeNull();
    }
  });

  it.each(['claude', 'openai_api', 'openrouter', 'nine_router:codex', 'codex-other', 'zai-other'])(
    'ignores metadata from non-Codex provider %s', (id) => {
      expect(resetCreditsInfo({ ...banked(2), id })).toBeNull();
    },
  );

  it('never infers a balance from a key/period date, quota window or purchased credits', () => {
    const quota = { id: '', label: 'Créditos comprados', percent: 50, used: 2, limit: 4, unit: 'credits',
      resetsAt: '2030-02-01T00:00:00Z', windowSeconds: 604800 };
    for (const kind of ['key', 'period'] as const) {
      const r = { ...report, validity: { kind, at: '2030-02-01T00:00:00Z' }, meters: [quota],
        spend: { amount: 2, currency: 'USD', periodLabel: 'Este mes', budget: 4 } };
      expect(resetCreditsInfo(r)).toBeNull();
      expect(resetCreditsInfo({ ...r, availableResets: 2 } as UsageReport)).toMatchObject({ count: 2 });
    }
  });
});

describe('server-reported z.ai reset credits', () => {
  const zaiBanked = (count: unknown): UsageReport => ({ ...report, id: 'zai', availableResets: count as number });

  it('shows the z.ai balance with its own provider note', () => {
    expect(resetCreditsInfo(zaiBanked(2))).toMatchObject({ count: 2, label: '2 resets disponibles' });
    expect(resetCreditsInfo(zaiBanked(1))).toMatchObject({ count: 1, label: '1 reset disponible' });
    expect(resetCreditsInfo(zaiBanked(2))?.title).toContain('saldo comunicado por z.ai');
    expect(resetCreditsInfo(zaiBanked(2))?.title).not.toContain('Codex');
  });

  it.each([null, undefined, -1, 0.5, '2', 4294967296])(
    'hides unknown or invalid count %s rather than assuming zero', (count) => {
      expect(resetCreditsInfo(zaiBanked(count))).toBeNull();
    },
  );

  it('hides stale and unsuccessful z.ai reports like Codex', () => {
    expect(resetCreditsInfo({ ...zaiBanked(2), status: 'warning' })?.count).toBe(2);
    expect(resetCreditsInfo({ ...zaiBanked(2), stale: true })).toBeNull();
    expect(resetCreditsInfo({ ...zaiBanked(2), status: 'error' })).toBeNull();
  });
});
