// Cuentas adicionales de un proveedor (src-tauri/src/config.rs › Account).
import type { Account, AccountProvider, AppConfig, ScopedSecretKey, SecretKey, SecretStatus } from './types';
import { ownedHomeDir } from './app-identity';

/** Proveedor de un id de informe: `claude` o `claude:trabajo` → `claude`. */
export const providerOf = (id: string): string => id.split(':')[0];

/** Secreto de la cuenta principal (`id` = proveedor) o de una adicional. */
export const secretKey = (key: SecretKey, accountId: string): ScopedSecretKey =>
  accountId.includes(':') ? `${key}@${accountId}` : key;

/** Proveedores con login por CLI y carpeta de sesión propia por cuenta. */
export const SESSION_DIR: Partial<Record<AccountProvider, { env: string; file: string }>> = {
  claude: { env: 'CLAUDE_CONFIG_DIR', file: '.credentials.json' },
  codex: { env: 'CODEX_HOME', file: 'auth.json' },
  gemini: { env: 'GEMINI_CLI_HOME', file: '.gemini\\oauth_creds.json' },
  grok: { env: 'GROK_HOME', file: 'auth.json' },
};

/** Cómo instalar el CLI con el que se inicia sesión (si falta en el equipo). */
export const CLI_INSTALL: Partial<Record<AccountProvider, { name: string; cmd: string; where: string; needs?: string }>> = {
  claude: { name: 'Claude Code', cmd: 'irm https://claude.ai/install.ps1 | iex', where: 'PowerShell' },
  codex: { name: 'Codex CLI', cmd: 'npm install -g @openai/codex', where: 'una terminal', needs: 'Node.js' },
  gemini: { name: 'Gemini CLI', cmd: 'npm install -g @google/gemini-cli', where: 'una terminal', needs: 'Node.js' },
};

/** Carpeta por defecto (igual que `Account::session_dir`). */
export const defaultSessionDir = (a: Pick<Account, 'id' | 'provider'>, appName: string | null = 'Quorb') =>
  `%USERPROFILE%\\${ownedHomeDir(appName)}\\accounts\\${a.provider}-${a.id.split(':')[1] ?? a.id}`;

export const accountsOf = (cfg: AppConfig, provider: string): Account[] => cfg.accounts.filter((a) => a.provider === provider);

/**
 * Número de cada cuenta («1» la principal, «2»… las adicionales en el orden de Ajustes)
 * para distinguir los círculos de un mismo proveedor. Solo proveedores con varias cuentas.
 */
export function accountTags(cfg: Pick<AppConfig, 'accounts'>): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Map<string, number>();
  for (const a of cfg.accounts) {
    const n = (seen.get(a.provider) ?? 1) + 1;
    seen.set(a.provider, n);
    out[a.provider] = '1';
    out[a.id] = String(n);
  }
  return out;
}

/** Sufijo nuevo, corto y sin chocar con los ids que ya hay. */
function newSuffix(taken: Set<string>, rand: () => number): string {
  for (;;) {
    const s = Math.floor(rand() * 36 ** 6)
      .toString(36)
      .padStart(6, '0');
    if (!taken.has(s)) return s;
  }
}

export function newAccount(cfg: AppConfig, provider: AccountProvider, rand: () => number = Math.random): Account {
  const taken = new Set(cfg.accounts.map((a) => a.id.split(':')[1]));
  return {
    id: `${provider}:${newSuffix(taken, rand)}`,
    provider,
    label: `Cuenta ${accountsOf(cfg, provider).length + 2}`,
    enabled: true,
    configDir: null,
    username: '',
    plan: provider === 'copilot' ? 'pro' : provider === 'nan' ? cfg.nan.plan : '',
    customAllowance: null,
    monthlyBudgetUsd: null,
  };
}

/** Secretos que guarda cada proveedor (igual que `secrets::for_provider`). */
export const ACCOUNT_SECRETS: Record<AccountProvider, SecretKey[]> = {
  claude: [],
  codex: [],
  gemini: [],
  grok: [],
  cursor: ['cursor_token'],
  copilot: ['github_token'],
  nan: ['nan_api_key', 'nan_session'],
  openrouter: ['openrouter_api_key'],
  zai: ['zai_api_key'],
  anthropic_api: ['anthropic_admin_key'],
  openai_api: ['openai_admin_key'],
  // Los sub-proveedores de 9Router comparten la sesión del dashboard (no scoped).
  nine_router: [],
};

/**
 * ¿Le falta algo a una cuenta adicional para poder consultarse? Se mira su
 * secreto scoped (`<secreto>@<id>`), que solo aparece en el mapa cuando el
 * backend enumera la cuenta ya persistida.
 */
export function accountReady(a: Account, s: SecretStatus): boolean {
  const has = (k: SecretKey) => !!s[secretKey(k, a.id)];
  switch (a.provider) {
    case 'cursor':
      return has('cursor_token');
    case 'copilot':
      return has('github_token') && a.username.trim() !== '';
    case 'nan':
      return has('nan_session') || has('nan_api_key');
    case 'openrouter':
      return has('openrouter_api_key');
    case 'anthropic_api':
      return has('anthropic_admin_key');
    case 'openai_api':
      return has('openai_admin_key');
    case 'nine_router':
      return has('nine_router_password');
    default:
      return true;
  }
}
