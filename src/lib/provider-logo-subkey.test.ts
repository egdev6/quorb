import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findLogo, normalizeLogoKey, ProviderLogo, subLogoKey } from '../components/ProviderLogo';

// Los nodos personalizados de 9Router se etiquetan con su id técnico en
// `byProvider`; el nombre visible llega en el `name` del informe («9Router · Zhipu»).
// `subLogoKey` deriva la clave de logo del nombre para que salga el logo correcto.
describe('9Router custom node logo keys', () => {
  it('uses the pretty node name when present', () => {
    expect(subLogoKey('nine_router:anthropic-compatible-0c354d0a-4d67-4c4e-a6ff-1360bc9c9344', '9Router · Zhipu')).toBe('zhipu');
    expect(
      subLogoKey('nine_router:openai-compatible-responses-1855f0b7-4442-4046-8368-4d11dda27b96', '9Router · QWEN - Alibaba'),
    ).toBe('qwen-alibaba');
  });

  it('renders monograms for sub-providers without an SVG', () => {
    for (const [id, name, monogram] of [
      ['nine_router:anthropic-compatible-x', '9Router · Zhipu', 'ZH'],
      ['nine_router:openai-compatible-responses-x', '9Router · QWEN - Alibaba', 'QA'],
    ]) {
      expect(findLogo(subLogoKey(id, name))).toBeUndefined();
      const markup = renderToStaticMarkup(createElement(ProviderLogo, { id, name }));
      expect(markup).toContain('logo__mono');
      expect(markup).toContain(`>${monogram}<`);
    }
  });

  it('does not include a PNG provider catalog', () => {
    expect(Object.keys(import.meta.glob('../assets/logos/*.png'))).toHaveLength(0);
  });

  it('keeps existing SVG logos for Codex and Copilot', () => {
    expect(findLogo('codex')?.kind).toBe('svg');
    expect(findLogo('copilot')?.kind).toBe('svg');
  });

  it('keeps the sanitized sub id for known providers without a custom name', () => {
    // Un sub-proveedor normal (no nodo): el nombre es «9Router · Kiro».
    expect(subLogoKey('nine_router:kiro', '9Router · Kiro')).toBe('kiro');
    expect(subLogoKey('nine_router:minimax-cn', '9Router · minimax-cn')).toBe('minimax-cn');
  });

  it('normalizes names to logo keys', () => {
    expect(normalizeLogoKey('QWEN - Alibaba')).toBe('qwen-alibaba');
    expect(normalizeLogoKey('Zhipu')).toBe('zhipu');
    expect(normalizeLogoKey('  Minimax CN ')).toBe('minimax-cn');
  });
});
