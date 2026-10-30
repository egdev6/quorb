import type { AppConfig } from './types';
import { isNineRouterId } from './visibility';

type MainKey = 'claude' | 'codex' | 'gemini' | 'cursor' | 'grok' | 'copilot' | 'nan' | 'openrouter' | 'minimax' | 'anthropicApi' | 'openaiApi' | 'zai' | 'opencodeGo';

/** Clave de configuración de cada cuenta principal; el id del informe puede ser distinto. */
export const CONFIG_KEY: Readonly<Record<string, MainKey>> = {
  claude: 'claude', codex: 'codex', gemini: 'gemini', cursor: 'cursor', grok: 'grok',
  copilot: 'copilot', nan: 'nan', openrouter: 'openrouter', minimax: 'minimax',
  anthropic_api: 'anthropicApi', openai_api: 'openaiApi',
  zai: 'zai',
  opencode_go: 'opencodeGo',
};

/**
 * Mapeo id de informe → clave de config para el flujo que compara borrador vs.
 * guardado (aviso «cambios sin guardar» del paso de conexión). Incluye 9Router,
 * que no está en `CONFIG_KEY` porque su visibilidad no usa las `accounts` ni la
 * clave genérica: sin esto, `sectionDirty('nine_router')` nunca detectaba el
 * borrador (p. ej. la Base URL cambiada sin guardar) y el paso «URL ahora»
 * consultaba el destino persistido como si no hubiera cambios.
 */
export function configKeyFor(id: string): MainKey | 'nineRouter' | undefined {
  if (id === 'nine_router') return 'nineRouter';
  return CONFIG_KEY[id];
}

export const isAccountVisible = (cfg: Pick<AppConfig, 'hiddenProviders'>, id: string, enabled: boolean) =>
  enabled && !cfg.hiddenProviders.includes(id);

/** Borrador manual: activar recupera solo este círculo, sin alterar otras ocultaciones. */
export function setAccountVisibility(cfg: AppConfig, id: string, enabled: boolean): AppConfig {
  // 9Router es un proveedor agregador: su orbe principal y sus sub-orbes comparten
  // `nineRouter`. Activarlo recupera TODOS sus orbes ocultados (no hay un id único
  // en CONFIG_KEY ni en accounts); desactivarlo solo apaga el proveedor.
  if (id === 'nine_router') {
    return {
      ...cfg,
      nineRouter: { ...cfg.nineRouter, enabled },
      hiddenProviders: enabled ? cfg.hiddenProviders.filter((x) => !isNineRouterId(x)) : cfg.hiddenProviders,
    };
  }
  let next: AppConfig;
  if (cfg.accounts.some((a) => a.id === id)) {
    next = { ...cfg, accounts: cfg.accounts.map((a) => a.id === id ? { ...a, enabled } : a) };
  } else {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_KEY, id)) return cfg;
    const key = CONFIG_KEY[id];
    next = { ...cfg, [key]: { ...cfg[key], enabled } };
  }
  return { ...next, hiddenProviders: enabled ? cfg.hiddenProviders.filter((x) => x !== id) : cfg.hiddenProviders };
}
