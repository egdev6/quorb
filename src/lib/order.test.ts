import { describe, expect, it } from 'vitest';
import { OFFICIAL_USAGE_URL, applyOrder, dropIndex, moveTo, officialUsageUrl } from './order';
import { reportSummary } from './format';
import type { UsageReport } from './types';

const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join();

describe('order', () => {
  it('applies a saved order, unknown ids go last', () => {
    const items = [{ id: 'claude' }, { id: 'codex' }, { id: 'nan' }, { id: 'openai_api' }];
    expect(ids(applyOrder(items, ['nan', 'claude']))).toBe('nan,claude,codex,openai_api');
    expect(ids(applyOrder(items, []))).toBe('claude,codex,nan,openai_api');
  });

  it('moves an id to a position', () => {
    expect(moveTo(['a', 'b', 'c', 'd'], 'a', 2).join()).toBe('b,c,a,d');
    expect(moveTo(['a', 'b', 'c'], 'c', 0).join()).toBe('c,a,b');
  });

  it('finds the drop index from centers', () => {
    expect(dropIndex([10, 50, 90], 5)).toBe(0);
    expect(dropIndex([10, 50, 90], 60)).toBe(2);
    expect(dropIndex([10, 50, 90], 200)).toBe(3);
  });

  it('resolves the official usage URL for main and scoped ids', () => {
    expect(officialUsageUrl('openrouter')).toBe(OFFICIAL_USAGE_URL.openrouter);
    expect(officialUsageUrl('openrouter:abc123')).toBe(OFFICIAL_USAGE_URL.openrouter);
    expect(officialUsageUrl('claude:trabajo')).toBe(OFFICIAL_USAGE_URL.claude);
    expect(officialUsageUrl('codex')).toBe('https://chatgpt.com/settings/usage?tab=overview');
    expect(officialUsageUrl('desconocido')).toBeUndefined();
    expect(officialUsageUrl('desconocido:abc')).toBeUndefined();
  });

  it('builds a copyable summary', () => {
    const r: UsageReport = {
      id: 'claude', name: 'Claude', kind: 'subscription', status: 'ok', plan: 'Max',
      meters: [{ label: 'Sesión · 5 h', percent: 37.4, used: null, limit: null, unit: null, resetsAt: null, windowSeconds: null }],
      spend: { amount: 4.5, currency: 'USD', periodLabel: 'Este mes', budget: null },
      message: null, action: null, fetchedAt: '',
    };
    expect(reportSummary(r).replace(/\u00a0/g, ' ')).toBe('Claude (Max)\n· Sesión · 5 h: 37 %\n· Este mes: 4,50 $');
  });
});
