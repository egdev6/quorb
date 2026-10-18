import { afterEach, describe, expect, it, vi } from 'vitest';
import { disclosureOpen, popupMeterColor, saveDisclosure } from './popup-preferences';
import type { Meter, UsageReport } from './types';

const meter = (windowSeconds: number | null, percent: number | null = 20): Meter => ({
  label: 'Limit', percent, used: null, limit: null, unit: null, resetsAt: null, windowSeconds,
});
const report = (meters: Meter[], kind: UsageReport['kind'] = 'subscription'): UsageReport => ({
  id: 'claude', name: 'Claude', kind, status: 'ok', plan: null, meters,
  spend: null, message: null, action: null, fetchedAt: '',
});
const colors = (r: UsageReport) => r.meters.filter(m => m.percent != null).map((m, i) => popupMeterColor(r, m, i));
afterEach(() => vi.unstubAllGlobals());

describe('popup preferences', () => {
  it('uses white hours and accent for every weekly quota regardless of order or count', () => {
    const white = '#ffffff';
    const accent = 'var(--popup-primary, #ff0036)';
    expect(colors(report([meter(18000), meter(604800), meter(604800), meter(604800)])))
      .toEqual([white, accent, accent, accent]);
    expect(colors(report([meter(604800), meter(18000)]))).toEqual([accent, white]);
  });

  it.each([
    [0, 604800, ['var(--ring-3)', 'var(--ring-1)']],
    [1, 604800, ['#ffffff', 'var(--popup-primary, #ff0036)']],
    [86399, 604800, ['#ffffff', 'var(--popup-primary, #ff0036)']],
    [86400, 604800, ['var(--ring-3)', 'var(--ring-1)']],
    [18000, 604799, ['var(--ring-2)', 'var(--ring-1)']],
    [18000, 1209599, ['#ffffff', 'var(--popup-primary, #ff0036)']],
    [18000, 1209600, ['var(--ring-2)', 'var(--ring-3)']],
  ] as const)('preserves the donor guard boundaries for %s / %s seconds', (hours, weekly, expected) => {
    expect(colors(report([meter(hours), meter(weekly)]))).toEqual(expected);
  });

  it('leaves single-window, unknown-window, unknown-percentage and API reports unchanged', () => {
    expect(colors(report([meter(18000)]))).toEqual(['var(--ring-2)']);
    expect(colors(report([meter(null), meter(604800)]))).toEqual(['var(--ring-3)', 'var(--ring-1)']);
    expect(colors(report([meter(18000, null), meter(604800)]))).toEqual(['var(--ring-1)']);
    expect(colors(report([meter(18000), meter(604800, null)]))).toEqual(['var(--ring-2)']);
    expect(colors(report([meter(18000), meter(604800)], 'api'))).toEqual(['var(--ring-2)', 'var(--ring-1)']);
  });

  it('defaults to expanded pace and collapsed history without storage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(disclosureOpen('claude', 'pace')).toBe(true);
    expect(disclosureOpen('claude', 'history')).toBe(false);
    expect(() => saveDisclosure('claude', 'pace', false)).not.toThrow();
  });

  it('persists both sections independently for each provider', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    saveDisclosure('claude', 'pace', false);
    saveDisclosure('claude', 'history', true);
    expect(disclosureOpen('claude', 'pace')).toBe(false);
    expect(disclosureOpen('claude', 'history')).toBe(true);
    expect(disclosureOpen('codex', 'pace')).toBe(true);
    expect(disclosureOpen('codex', 'history')).toBe(false);
    values.set('popup:claude:pace', 'invalid');
    expect(disclosureOpen('claude', 'pace')).toBe(true);
  });

  it('persists separate disclosure choices for accounts of the same provider', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });

    saveDisclosure('claude', 'pace', false);
    saveDisclosure('claude', 'history', true);
    saveDisclosure('claude:extra', 'pace', true);
    saveDisclosure('claude:extra', 'history', false);

    expect(disclosureOpen('claude', 'pace')).toBe(false);
    expect(disclosureOpen('claude', 'history')).toBe(true);
    expect(disclosureOpen('claude:extra', 'pace')).toBe(true);
    expect(disclosureOpen('claude:extra', 'history')).toBe(false);
    expect(disclosureOpen('claude:other', 'pace')).toBe(true);
    expect(disclosureOpen('claude:other', 'history')).toBe(false);
  });
});
