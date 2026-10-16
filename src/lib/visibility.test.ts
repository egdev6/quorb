import { describe, expect, it } from 'vitest';
import { hiddenNineRouterIds, isNineRouterId, nineRouterSubName, revealIds, revealNineRouter } from './visibility';

describe('9Router visibility', () => {
  it('recognizes nine_router ids (aggregate orb and sub-orbs)', () => {
    expect(isNineRouterId('nine_router')).toBe(true);
    expect(isNineRouterId('nine_router:kiro')).toBe(true);
    expect(isNineRouterId('nine_router:openai-compatible-responses-x')).toBe(true);
    expect(isNineRouterId('claude')).toBe(false);
    expect(isNineRouterId('nan:work')).toBe(false);
  });

  // Regresión del punto 1: reactivar 9Router debe recuperar sus orbes ocultados.
  it('revealNineRouter clears nine_router ids but keeps the rest', () => {
    const hidden = ['nine_router', 'nine_router:kiro', 'claude:trabajo', 'nan'];
    expect(revealNineRouter(hidden)).toEqual(['claude:trabajo', 'nan']);
  });

  it('lists only the hidden nine_router ids', () => {
    expect(hiddenNineRouterIds(['nine_router:x', 'claude', 'nine_router:y'])).toEqual(['nine_router:x', 'nine_router:y']);
  });

  it('reveals a single sub-orb id', () => {
    expect(revealIds(['nine_router:x', 'nine_router:y'], ['nine_router:x'])).toEqual(['nine_router:y']);
  });

  it('builds a readable sub-orb name', () => {
    expect(nineRouterSubName('nine_router')).toBe('9Router');
    expect(nineRouterSubName('nine_router:kiro')).toBe('9Router · kiro');
  });
});
