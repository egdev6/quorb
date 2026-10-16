import { describe, expect, it } from 'vitest';
import { ACCOUNT_SECRETS, accountTags, defaultSessionDir, newAccount, providerOf, secretKey } from './accounts';
import type { AppConfig } from './types';

const cfg = (accounts: AppConfig['accounts'] = []) => ({ accounts, nan: { plan: 'premium' } }) as unknown as AppConfig;

describe('accounts', () => {
  it('maps report ids to their provider', () => {
    expect(providerOf('claude')).toBe('claude');
    expect(providerOf('claude:abc123')).toBe('claude');
  });

  it('scopes secrets only for extra accounts', () => {
    expect(secretKey('openrouter_api_key', 'openrouter')).toBe('openrouter_api_key');
    expect(secretKey('openrouter_api_key', 'openrouter:abc123')).toBe('openrouter_api_key@openrouter:abc123');
  });

  it('creates accounts with unique ids and sensible defaults', () => {
    const a = newAccount(cfg(), 'copilot', () => 0);
    expect(a).toMatchObject({ id: 'copilot:000000', label: 'Cuenta 2', enabled: true, plan: 'pro' });
    let n = 0;
    const b = newAccount(cfg([a]), 'copilot', () => (n++ === 0 ? 0 : 0.5));
    expect(b.id).not.toBe(a.id);
    expect(b.label).toBe('Cuenta 3');
    expect(b.id).toMatch(/^copilot:[a-z0-9]{6}$/);
    expect(newAccount(cfg(), 'nan').plan).toBe('premium');
  });

  it('shows the default session folder', () => {
    expect(defaultSessionDir({ id: 'claude:w1', provider: 'claude' })).toBe('%USERPROFILE%\\.quorb\\accounts\\claude-w1');
  });
  it('shows the stable session folder and rejects a foreign identity', () => {
    expect(defaultSessionDir({ id: 'claude:w1', provider: 'claude' }, 'Quorb')).toBe('%USERPROFILE%\\.quorb\\accounts\\claude-w1');
    expect(defaultSessionDir({ id: 'claude:w1', provider: 'claude' }, 'Otra App')).toBe('%USERPROFILE%\\…\\accounts\\claude-w1');
  });
  it('numbers the circles of providers with several accounts', () => {
    const acc = (id: string) => ({ id, provider: id.split(':')[0] }) as AppConfig['accounts'][number];
    expect(accountTags(cfg([acc('claude:a'), acc('codex:b'), acc('claude:c')]))).toEqual({
      claude: '1',
      'claude:a': '2',
      'claude:c': '3',
      codex: '1',
      'codex:b': '2',
    });
    expect(accountTags(cfg())).toEqual({});
  });

  it('treats 9Router sub-providers as accounts of the aggregator', () => {
    // El sub-proveedor `nine_router:claude` cuelga del proveedor `nine_router`.
    expect(providerOf('nine_router')).toBe('nine_router');
    expect(providerOf('nine_router:claude')).toBe('nine_router');
    // Comparten la sesión del dashboard: no guardan secreto propio por cuenta.
    expect(ACCOUNT_SECRETS.nine_router).toEqual([]);
    expect(secretKey('nine_router_password', 'nine_router:claude')).toBe('nine_router_password@nine_router:claude');
  });
});
