import { describe, expect, it } from 'vitest';
import { findLogo } from '../components/ProviderLogo';

// GitHub Copilot (the coding assistant billed by GitHub) must not fall back to
// the Microsoft Copilot ribbon, which is a different product (#206).
describe('GitHub Copilot logo', () => {
  it('resolves copilot to the monochrome GitHub Copilot mark', () => {
    const logo = findLogo('copilot');
    expect(logo?.kind).toBe('svg');
    const markup = logo?.kind === 'svg' ? logo.markup : '';
    expect(markup).toContain('viewBox="0 0 256 208"');
    expect(markup).toContain('fill="currentColor"');
  });

  it('no longer ships the Microsoft Copilot logo', () => {
    expect(findLogo('microsoft-copilot')).toBeUndefined();
  });
});
