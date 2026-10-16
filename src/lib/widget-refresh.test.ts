import { describe, expect, it } from 'vitest';
import { dataKey, needsRefresh } from './widget-refresh';
import type { AppConfig } from './types';

// Config mínima con todos los proveedores; cada test cambia uno y comprueba si
// obliga a refrescar. Regresión del punto 2: antes cambiar 9Router no refrescaba.
function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    claude: { enabled: true },
    codex: { enabled: true },
    gemini: { enabled: true },
    cursor: { enabled: true },
    copilot: { enabled: true },
    openrouter: { enabled: true },
    nan: { enabled: true },
    anthropicApi: { enabled: false },
    openaiApi: { enabled: false },
    nineRouter: { enabled: true, baseUrl: 'http://localhost:20128', period: '7d', showSubProviders: true, minSpendUsd: 0, monthlyBudgetUsd: null },
    ...over,
  } as unknown as AppConfig;
}

describe('widget refresh discriminator', () => {
  it('refreshes when 9Router changes (period, budget, threshold, breakdown, enabled)', () => {
    const base = cfg();
    expect(needsRefresh(base, cfg({ nineRouter: { ...base.nineRouter, period: '30d' } }))).toBe(true);
    expect(needsRefresh(base, cfg({ nineRouter: { ...base.nineRouter, monthlyBudgetUsd: 50 } }))).toBe(true);
    expect(needsRefresh(base, cfg({ nineRouter: { ...base.nineRouter, minSpendUsd: 1 } }))).toBe(true);
    expect(needsRefresh(base, cfg({ nineRouter: { ...base.nineRouter, showSubProviders: false } }))).toBe(true);
    expect(needsRefresh(base, cfg({ nineRouter: { ...base.nineRouter, enabled: false } }))).toBe(true);
  });

  it('refreshes when other providers change', () => {
    const base = cfg();
    expect(needsRefresh(base, cfg({ claude: { enabled: false } } as Partial<AppConfig>))).toBe(true);
  });

  it('does not refresh when nothing relevant changes', () => {
    const base = cfg();
    expect(needsRefresh(base, cfg())).toBe(false);
    // Cambios cosméticos (fuera de dataKey) no cuentan.
    expect(needsRefresh(base, cfg({ accentColor: '#ff0000' } as Partial<AppConfig>))).toBe(false);
  });

  it('handles a null previous config', () => {
    expect(dataKey(null)).toBe('');
    expect(needsRefresh(null, cfg())).toBe(true);
  });
});
