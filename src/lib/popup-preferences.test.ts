import { afterEach, describe, expect, it, vi } from 'vitest';
import { disclosureOpen, saveDisclosure } from './popup-preferences';
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
