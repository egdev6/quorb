// Espejo de src-tauri/src/model.rs y config.rs

export type Status = 'ok' | 'warning' | 'error' | 'needsLogin' | 'unconfigured';
export type Kind = 'subscription' | 'api';

export interface Meter {
  /** Identificador estable (snake_case); la lógica se apoya en él, no en `label`. Vacío en datos antiguos. */
  id: string;
  label: string;
  percent: number | null;
  used: number | null;
  limit: number | null;
  unit: string | null;
  resetsAt: string | null;
  /** Duración de la ventana en segundos (5 h, 7 días, mes…) */
  windowSeconds: number | null;
}

export interface Spend {
  amount: number;
  currency: string;
  periodLabel: string;
  budget: number | null;
}

export interface UsageReport {
  id: string;
  name: string;
  kind: Kind;
  status: Status;
  plan: string | null;
  /** Explicit provider dates only; period end does not confirm cancellation. */
  validity?: { at: string; kind: 'period' | 'key' } | null;
  /** Saldo de resets comunicado por Codex, no una proyección de reinicios automáticos. */
  availableResets?: number | null;
  meters: Meter[];
  spend: Spend | null;
  message: string | null;
  action: 'login' | 'settings' | null;
  /** Tokens por día, si el proveedor los da (NaN) */
  daily?: { date: string; value: number }[];
  fetchedAt: string;
  /** Solo frontend: datos del último ciclo correcto porque el actual falló. */
  stale?: boolean;
}

export interface SubscriptionConfig {
  enabled: boolean;
  credentialsPath: string | null;
  loginCommand: string;
}

export interface ApiCostConfig {
  enabled: boolean;
  monthlyBudgetUsd: number | null;
}

/** MiniMax. `baseUrl` cubre las dos regiones: global `api.minimax.io` y China `api.minimaxi.com`. */
export interface MiniMaxConfig {
  enabled: boolean;
  baseUrl: string;
}

export interface NanConfig {
  enabled: boolean;
  baseUrl: string;
  plan: 'community' | 'member' | 'premium' | string;
  usageUrl: string | null;
  usedPointer: string | null;
  limitPointer: string | null;
  usageLabel: string | null;
  /** Día de inicio del periodo de facturación (solo glm5.3) */
  billingDay: number;
}

/** Periodos de uso que acepta 9Router (`GET /api/usage/stats?period=…`). */
export type NineRouterPeriod = 'today' | '24h' | '7d' | '30d' | '60d' | 'all';

/** Proveedor agregador local: lee el uso que 9Router ya registra. */
export interface NineRouterConfig {
  enabled: boolean;
  /** Base del servidor local (por defecto http://localhost:20128) */
  baseUrl: string;
  period: NineRouterPeriod;
  /** Presupuesto opcional en USD para pintar la barra de gasto */
  monthlyBudgetUsd: number | null;
  /** Mostrar cada sub-proveedor (Claude, Kiro, GLM…) como su propia cuenta */
  showSubProviders: boolean;
  /** Gasto mínimo en USD para mostrar un sub-proveedor como orbe (0 = los que gasten) */
  minSpendUsd: number;
}

export type Effect = 'confetti' | 'glow' | 'custom' | 'none';
export type AlertMoment = 'exceeded' | 'reset';
export type MediaSize = 'small' | 'medium' | 'full';

/** Avisos en dos momentos: al superar el límite y al reiniciarse. */
export interface AlertsConfig {
  enabled: boolean;
  native: boolean;
  /** % a partir del cual se considera superado */
  threshold: number;
  exceededEffect: Effect;
  onReset: boolean;
  resetEffect: Effect;
  /** Efecto propio: vídeo WebM con alfa o GIF/WebP/APNG animado */
  exceededMedia: string | null;
  resetMedia: string | null;
  mediaSize: MediaSize;
  mediaSound: boolean;
}

/** Atajos globales en formato «Ctrl+Alt+U»; vacío = sin atajo */
export interface ShortcutsConfig {
  enabled: boolean;
  toggle: string;
  openPeak: string;
  refresh: string;
}

export interface CopilotConfig {
  enabled: boolean;
  username: string;
  plan: 'free' | 'pro' | 'pro_plus' | 'business' | 'enterprise' | 'custom' | string;
  customAllowance: number | null;
}

/** Idioma de la interfaz (config.rs › LOCALES). El backend sanea cualquier otro valor a `es`. */
export type Locale = 'es' | 'en';

export interface AppConfig {
  /** Idioma de la interfaz; `es` por defecto */
  locale: Locale;
  refreshMinutes: number;
  opacity: number;
  compact: boolean;
  /** Mostrar el saldo de resets en los círculos; el popup lo conserva siempre. */
  showResets: boolean;
  /** Diámetro de los círculos (px) */
  orbSize: number;
  /** Color base de anillos y barras (#rrggbb) */
  accentColor: string;
  alwaysOnTop: boolean;
  dockEdge: 'top' | 'bottom' | 'left' | 'right';
  dockOffset: number;
  dockMonitor: string | null;
  autoHide: boolean;
  /** Buscar actualizaciones automáticamente */
  autoUpdate: boolean;
  providerOrder: string[];
  hiddenProviders: string[];
  alerts: AlertsConfig;
  shortcuts: ShortcutsConfig;
  claude: SubscriptionConfig;
  codex: SubscriptionConfig;
  gemini: SubscriptionConfig;
  cursor: SubscriptionConfig;
  grok: SubscriptionConfig;
  copilot: CopilotConfig;
  openrouter: { enabled: boolean };
  anthropicApi: ApiCostConfig;
  openaiApi: ApiCostConfig;
  nan: NanConfig;
  minimax: MiniMaxConfig;
  nineRouter: NineRouterConfig;
  /** Cuentas adicionales de un proveedor (la principal es la de su campo) */
  accounts: Account[];
}

export type AccountProvider =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'grok'
  | 'cursor'
  | 'copilot'
  | 'nan'
  | 'openrouter'
  | 'anthropic_api'
  | 'openai_api'
  | 'nine_router';

/** Cuenta adicional (config.rs › Account). `id` = `<proveedor>:<sufijo>` */
export interface Account {
  id: string;
  provider: AccountProvider;
  /** Nombre en la tira: «Claude · Trabajo» */
  label: string;
  enabled: boolean;
  /** Claude, Codex y Gemini: carpeta de sesión del CLI; null = la de Quorb */
  configDir: string | null;
  /** Copilot */
  username: string;
  /** Copilot o NaN */
  plan: string;
  customAllowance: number | null;
  /** Anthropic / OpenAI API */
  monthlyBudgetUsd: number | null;
}

export type SecretKey =
  | 'anthropic_admin_key'
  | 'openai_admin_key'
  | 'nan_api_key'
  | 'nan_session'
  | 'openrouter_api_key'
  | 'minimax_subscription_key'
  | 'minimax_api_key'
  | 'github_token'
  | 'cursor_token'
  | 'nine_router_password'
  | 'nine_router_session'
  | 'nine_router_bound_url';
/** Secreto de la cuenta principal o de una adicional (`<secreto>@<id de cuenta>`) */
export type ScopedSecretKey = SecretKey | `${SecretKey}@${string}`;
export type SecretStatus = Partial<Record<ScopedSecretKey, boolean>>;

/** Límites del tamaño de los círculos (iguales que en config.rs). */
export const ORB_SIZE = { min: 32, max: 80, default: 48 } as const;

/** Punto del historial (src-tauri/src/history.rs) */
export interface Sample {
  t: number;
  p: string;
  l: string;
  v: number;
}
