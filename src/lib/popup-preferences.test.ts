import { afterEach, describe, expect, it, vi } from 'vitest';
import { disclosureOpen, popupRingStyle, saveDisclosure } from './popup-preferences';
import type { UsageReport, Meter } from './types';

const meter = (windowSeconds: number | null): Meter => ({ label: 'Limit', percent: 20, used: null, limit: null, unit: null, resetsAt: null, windowSeconds });
const report = (meters: Meter[], kind: UsageReport['kind'] = 'subscription'): UsageReport => ({
  id: 'claude', name: 'Claude', kind, status: 'ok', plan: null, meters,
  spend: null, message: null, action: null, fetchedAt: '',
});
afterEach(() => vi.unstubAllGlobals());

describe('popup preferences', () => {
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

  it('uses white for hours and primary for weekly windows, regardless of order', () => {
    const style = popupRingStyle(report([meter(18000), meter(604800), meter(604800)]));
    expect(style).toMatchObject({ '--ring-1': '#ffffff' });
    expect(style?.['--ring-2' as keyof typeof style]).toContain('--popup-primary');
    expect(style?.['--ring-3' as keyof typeof style]).toContain('--popup-primary');
    expect(popupRingStyle(report([meter(604800), meter(18000)]))).toMatchObject({ '--ring-2': '#ffffff' });
  });

  it('leaves single-window, unknown-window and API reports unchanged', () => {
    expect(popupRingStyle(report([meter(18000)]))).toBeUndefined();
    expect(popupRingStyle(report([meter(null), meter(604800)]))).toBeUndefined();
    expect(popupRingStyle(report([meter(18000), meter(604800)], 'api'))).toBeUndefined();
  });
});
