import { describe, expect, it } from 'vitest';
import { meterColor } from './meter-colors';
import type { Meter, UsageReport } from './types';

const meter = (id: string, label: string, windowSeconds: number | null = null): Meter => ({
  id,
  label,
  percent: 10,
  used: null,
  limit: null,
  unit: null,
  resetsAt: null,
  windowSeconds,
});
const report = (id = 'claude'): UsageReport => ({
  id,
  name: id,
  kind: 'subscription',
  status: 'ok',
  plan: null,
  meters: [],
  spend: null,
  message: null,
  action: null,
  fetchedAt: '',
});

describe('meterColor without window duration', () => {
  it.each(['claude', 'codex'])('decides by meter id for %s, whatever the label says', (provider) => {
    const r = report(provider);
    expect(meterColor(r, meter('session', 'Session · 5 h'), 0)).toBe('var(--ring-2)');
    for (const id of ['weekly', 'weekly_opus', 'weekly_sonnet', 'weekly_apps']) {
      expect(meterColor(r, meter(id, 'Translated label'), 0)).toBe('var(--ring-1)');
    }
    expect(meterColor(r, meter('extra_usage', 'Extra usage'), 0)).toBe('var(--ring-3)');
    expect(meterColor(r, meter('credits', 'Credits'), 0)).toBe('var(--ring-3)');
  });

  it('lets the id win over a conflicting label', () => {
    expect(meterColor(report(), meter('weekly', 'Sesión · 5 h'), 0)).toBe('var(--ring-1)');
    expect(meterColor(report(), meter('session', 'Semana · todos'), 0)).toBe('var(--ring-2)');
  });

  it('keeps the label regex only as the last fallback for an empty id', () => {
    expect(meterColor(report(), meter('', 'Semana · todos'), 0)).toBe('var(--ring-1)');
    expect(meterColor(report(), meter('', 'Sesión · 5 h'), 0)).toBe('var(--ring-2)');
    expect(meterColor(report(), meter('', 'Extra'), 0)).toBe('var(--ring-3)');
  });

  it('keeps duration ahead of the id', () => {
    expect(meterColor(report(), meter('session', 'x', 7 * 86400), 0)).toBe('var(--ring-1)');
  });
});
