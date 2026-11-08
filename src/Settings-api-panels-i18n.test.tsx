// Corte visible de i18n para los paneles de APIs y las conexiones NaN/9Router
// (#66, T2c slice 2 C2): OpenRouter, NaN Builders, 9Router, Anthropic API y
// OpenAI API —incluidos NanConnect, NanProbe, NineRouterConnect y CodexInstall—
// renderizados en servidor (renderToStaticMarkup, sin DOM falso) con los
// literales exactos: en español tal y como estaban en el código y en inglés
// tras la migración.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CodexInstall } from './components/CodexInstall';
import type { CodexInstallController, CodexInstallState, CodexSetupStatus } from './lib/codex-install';
import type { AppConfig, Locale } from './lib/types';
import {
  AdminApiPanel,
  NanConnect,
  NanPanel,
  NineRouterConnect,
  NineRouterPanel,
  OpenRouterPanel,
} from './Settings';

const noop = () => {};

const expectAll = (html: string, texts: string[], label: string) => {
  for (const text of texts) expect(html, `falta «${text}» en ${label}`).toContain(text);
};
const expectNone = (html: string, texts: string[], label: string) => {
  for (const text of texts) expect(html, `sobra «${text}» en ${label}`).not.toContain(text);
};

// Config mínima: solo lo que leen los paneles de APIs.
const base = {
  hiddenProviders: [],
  openrouter: { enabled: true },
  nan: { enabled: true, plan: 'community', baseUrl: 'https://api.nan.builders', billingDay: 1, usageUrl: null, usedPointer: null, limitPointer: null, usageLabel: null },
  nineRouter: { enabled: true, period: '7d', showSubProviders: false, minSpendUsd: 0, monthlyBudgetUsd: null, baseUrl: 'http://localhost:20128' },
  anthropicApi: { enabled: true, monthlyBudgetUsd: null },
  openaiApi: { enabled: true, monthlyBudgetUsd: null },
  accounts: [],
} as unknown as AppConfig;

const healthFor = (locale: Locale) => (_id: string, hidden: boolean) => ({
  saved: null,
  secretsSig: '',
  dirty: false,
  hidden,
  saving: false,
  onSave: () => Promise.resolve(true),
  locale,
});

const common = (locale: Locale, cfg: AppConfig = base) => ({
  locale,
  cfg,
  secrets: {},
  set: noop,
  setVisibility: noop,
  loadSecrets: noop,
  healthFor: healthFor(locale),
});

const openrouter = (locale: Locale) => renderToStaticMarkup(<OpenRouterPanel {...common(locale)} />);
const nanPanel = (locale: Locale) => renderToStaticMarkup(<NanPanel {...common(locale)} />);
const nineRouter = (locale: Locale, cfg: AppConfig = base) => renderToStaticMarkup(<NineRouterPanel {...common(locale, cfg)} />);
const adminApi = (locale: Locale, tab: 'anthropic_api' | 'openai_api') => renderToStaticMarkup(<AdminApiPanel {...common(locale)} tab={tab} />);
const nanConnect = (locale: Locale, connected: boolean) => renderToStaticMarkup(<NanConnect locale={locale} connected={connected} onChange={noop} />);
const nineConnect = (locale: Locale, connected: boolean) =>
  renderToStaticMarkup(<NineRouterConnect locale={locale} connected={connected} baseUrl="http://localhost:20128" onChange={noop} />);

// Estado inyectable del controlador de CodexInstall: cada vista se fuerza sin montar React.
const codexState = (patch: Partial<CodexInstallState>): CodexInstallState => ({
  status: null,
  reading: false,
  installing: false,
  outcome: null,
  message: null,
  error: null,
  errorFrom: null,
  ...patch,
});
const codexStatus = (patch: Partial<CodexSetupStatus>): CodexSetupStatus => ({
  supported: true,
  busy: false,
  nodeAvailable: true,
  installed: false,
  package: '',
  message: null,
  outcome: null,
  ...patch,
});
const controllerFor = (state: CodexInstallState): CodexInstallController => ({
  getState: () => state,
  subscribe: () => () => {},
  setVisible: noop,
  start: noop,
  stop: noop,
  refresh: async () => state,
  requestInstall: async () => ({ ok: true, outcome: 'installed' }),
});
const codex = (locale: Locale, state: CodexInstallState) => renderToStaticMarkup(<CodexInstall locale={locale} controller={controllerFor(state)} onRecheck={noop} />);

describe('API provider panels (SSR, i18n)', () => {
  it('renders the Spanish literals of OpenRouter copied verbatim from the current code', () => {
    expectAll(
      openrouter('es'),
      [
        'Pago por uso · API oficial',
        'Mostrar en el widget',
        'Gasto del mes y de hoy, límite de la key (si tiene) y saldo de la cuenta.',
        'aria-label="Cómo conectar la cuenta"',
        '<b>API key</b>',
        'Créala en',
        'openrouter.ai › Keys',
        'Comprobando la conexión…',
      ],
      'es openrouter',
    );
  });

  it('renders OpenRouter in English and drops the Spanish literals', () => {
    const html = openrouter('en');
    expectAll(
      html,
      ['Pay-as-you-go · Official API', 'Show in the widget', 'This month&#x27;s and today&#x27;s spend, key limit (if any) and account balance.', 'aria-label="How to connect the account"', 'Create it at', 'openrouter.ai › Keys'],
      'en openrouter',
    );
    expectNone(html, ['Pago por uso', 'Mostrar en el widget', 'Cómo conectar la cuenta', 'Créala en', 'Gasto del mes'], 'en openrouter');
  });

  it('renders the Spanish literals of NaN (panel, connect, probe and advanced) copied verbatim', () => {
    expectAll(
      nanPanel('es'),
      [
        'Suscripción · cuenta o API key',
        'Con la cuenta conectada ves lo mismo que en tu dashboard: tokens usados frente a la cuota de cada modelo, cuándo se reinicia y la serie',
        '<code>/v1/usage</code>',
        'Conecta tu cuenta o pega una API key',
        'Conectar tu cuenta (recomendado)',
        'placeholder="tu@correo.com"',
        'Enviar enlace',
        'Igual que «nan auth login --email»: NaN te manda un enlace de un solo uso. No lo abras en el navegador (se gastaría): cópialo y pégalo aquí. La sesión se guarda en el almacén de credenciales del sistema y da los mismos datos que tu dashboard.',
        'API key (alternativa)',
        'cloud.nan.builders',
        '› API Keys',
        'nan_community</option>',
        '<option value="premium">GLM Premium</option>',
        'Avanzado · URL, facturación y endpoint de consumo',
        'Base URL',
        'Día de inicio de facturación',
        'Solo para GLM 5.3 (cuenta por periodo de Stripe) cuando usas la API key.',
        'Probar la API de NaN con la key',
        'Ver respuestas de /v1/models y /v1/usage',
        'Endpoint de consumo · URL',
        'JSON Pointer · usado',
        'p. ej. /usage/used_tokens',
        'JSON Pointer · límite',
        'p. ej. /usage/quota_tokens',
        'Etiqueta',
        'placeholder="Consumo"',
      ],
      'es nan',
    );
  });

  it('renders the NaN panel in English and drops the Spanish literals', () => {
    const html = nanPanel('en');
    expectAll(
      html,
      [
        'Subscription · account or API key',
        'Connect your account or paste an API key',
        'Connect your account (recommended)',
        'placeholder="you@email.com"',
        'Send link',
        'API key (alternative)',
        'Advanced · URL, billing and usage endpoint',
        'Billing start day',
        'Test the NaN API with your key',
        'See /v1/models and /v1/usage responses',
        'Usage endpoint · URL',
        'JSON Pointer · used',
        'e.g. /usage/used_tokens',
        'JSON Pointer · limit',
        'Label',
        'placeholder="Usage"',
      ],
      'en nan',
    );
    expectNone(html, ['Suscripción · cuenta o API key', 'Conecta tu cuenta o pega una API key', 'Día de inicio de facturación', 'Etiqueta', 'Probar la API de NaN', 'p. ej.'], 'en nan');
  });

  it('renders the Spanish literals of the connected NaN account copied verbatim', () => {
    expectAll(nanConnect('es', true), ['Cuenta de NaN Cloud conectada', 'Desconectar'], 'es nan conectada');
  });

  it('renders the connected NaN account in English', () => {
    const html = nanConnect('en', true);
    expectAll(html, ['NaN Cloud account connected', 'Disconnect'], 'en nan conectada');
    expectNone(html, ['Cuenta de NaN Cloud conectada', 'Desconectar'], 'en nan conectada');
  });

  it('renders the Spanish literals of 9Router (panel, connect, periods and hidden sub-orbs) copied verbatim', () => {
    const html = nineRouter('es');
    expectAll(
      html,
      [
        'Pasarela local · uso agregado',
        'Quorb lee el uso y el gasto que <b>9Router</b> ya registra en tu equipo: peticiones, tokens y coste por proveedor del periodo.',
        'aria-label="Cómo conectar 9Router"',
        'Conecta tu dashboard local',
        'Conectar con el dashboard',
        'Contraseña del dashboard',
        'Guardar y probar',
        'La contraseña del dashboard de 9Router (por defecto «123456» hasta que la cambies). Se guarda en el almacén seguro del sistema.',
        'Periodo y desglose',
        'Periodo de uso',
        'Rango que muestra el orbe y su historial.',
        '<option value="today">Hoy</option>',
        '<option value="24h">Últimas 24 h</option>',
        'Últimos 7 días</option>',
        '<option value="30d">Últimos 30 días</option>',
        '<option value="60d">Últimos 60 días</option>',
        '<option value="all">Todo</option>',
        'Mostrar cada sub-proveedor como su propia cuenta',
        'Gasto mínimo por sub-proveedor (USD)',
        'Presupuesto (USD)',
        'Avanzado · dirección del servidor',
        'Dónde escucha 9Router (por defecto http://localhost:20128).',
      ],
      'es 9router',
    );
    // Suborbes ocultos: solo se pintan con ids ocultos de 9Router.
    expectAll(
      nineRouter('es', { ...base, hiddenProviders: ['nine_router:kiro'] } as AppConfig),
      ['Suborbes ocultos de 9Router', '9Router · kiro · mostrar', 'Los ocultaste desde su panel en la tira. Pulsa para volver a mostrarlos.'],
      'es 9router ocultos',
    );
    void html;
  });

  it('renders the 9Router panel in English and drops the Spanish literals', () => {
    const html = nineRouter('en');
    expectAll(
      html,
      [
        'Local gateway · aggregated usage',
        'aria-label="How to connect 9Router"',
        'Connect your local dashboard',
        'Connect to the dashboard',
        'Dashboard password',
        'Save and test',
        'Period and breakdown',
        'Usage period',
        '<option value="today">Today</option>',
        '<option value="24h">Last 24 h</option>',
        '<option value="all">All</option>',
        'Show each sub-provider as its own account',
        'Minimum spend per sub-provider (USD)',
        'Budget (USD)',
        'Advanced · server address',
        'Where 9Router listens (http://localhost:20128 by default).',
      ],
      'en 9router',
    );
    expectNone(html, ['Pasarela local', 'Conecta tu dashboard local', 'Periodo de uso', 'Presupuesto (USD)', 'Últimos'], 'en 9router');
  });

  it('renders the connected 9Router account in Spanish and English', () => {
    expectAll(
      nineConnect('es', true),
      ['9Router conectado · volver a conectar', 'placeholder="•••••••• (configurada)"', 'Quitar', 'title="Desconectar 9Router"'],
      'es 9router conectado',
    );
    const html = nineConnect('en', true);
    expectAll(html, ['9Router connected · reconnect', 'placeholder="•••••••• (configured)"', 'Remove', 'title="Disconnect 9Router"'], 'en 9router conectado');
    expectNone(html, ['9Router conectado', 'Quitar', 'configurada)'], 'en 9router conectado');
  });

  it('renders the Spanish literals of the Anthropic API and OpenAI API panels copied verbatim', () => {
    expectAll(
      adminApi('es', 'anthropic_api'),
      ['Pago por uso · Admin key', 'Anthropic API', 'Mostrar gasto del mes', '<b>Admin key</b>', 'Admin API key (sk-ant-admin…)', 'Las APIs de coste no admiten OAuth: hace falta una', '(solo lectura de la organización).', 'Admin key</a> (solo lectura de la organización).', 'Presupuesto mensual (opcional)', 'USD al mes'],
      'es anthropic',
    );
    expectAll(adminApi('es', 'openai_api'), ['OpenAI API', 'class="eg-field__label">Admin key<', 'Créala en', 'Organization › Admin keys'], 'es openai');
  });

  it('renders the Anthropic API and OpenAI API panels in English and drops the Spanish literals', () => {
    const anthropic = adminApi('en', 'anthropic_api');
    expectAll(anthropic, ['Pay-as-you-go · Admin key', 'Show month spend', 'Cost APIs do not support OAuth: you need an', '(organization read-only).', 'Admin key</a> (organization read-only).', 'Monthly budget (optional)', 'USD per month'], 'en anthropic');
    expectNone(anthropic, ['Pago por uso', 'Mostrar gasto del mes', 'Presupuesto mensual', 'hace falta una'], 'en anthropic');
    const openai = adminApi('en', 'openai_api');
    expectAll(openai, ['Pay-as-you-go · Admin key', 'Create it at', 'Organization › Admin keys'], 'en openai');
    expectNone(openai, ['Créala en', 'Mostrar gasto del mes'], 'en openai');
  });
});

describe('CodexInstall notice (SSR, i18n)', () => {
  it('renders every Spanish view copied verbatim from the current code', () => {
    expectAll(codex('es', codexState({})), ['<b>Comprobando Codex CLI…</b>', 'Quorb solo consulta el estado del equipo.'], 'es loading');
    expectAll(codex('es', codexState({ status: codexStatus({}) })), ['<b>Falta Codex CLI en este equipo.</b>', 'Quorb puede instalarlo desde aquí: Windows pedirá confirmación antes de instalar nada.', 'Instalar Codex', 'Qué instala exactamente'], 'es ready');
    expectAll(codex('es', codexState({ installing: true })), ['<b>Instalando Codex CLI…</b>', 'Instalando…'], 'es installing');
    expectAll(codex('es', codexState({ outcome: 'installed' })), ['<b>Codex CLI instalado.</b>', 'La instalación no crea la sesión: usa «Iniciar sesión» cuando quieras.'], 'es installed fresh');
    expectAll(codex('es', codexState({ status: codexStatus({ installed: true }) })), ['<b>Codex está instalado; revisa tu comando de login.</b>', 'Quorb ya detecta el CLI en este equipo.'], 'es installed stale');
    expectAll(codex('es', codexState({ outcome: 'cancelled' })), ['<b>Instalación cancelada.</b>', 'No se cambió nada. Puedes intentarlo de nuevo.', 'Reintentar'], 'es cancelled');
    expectAll(codex('es', codexState({ status: codexStatus({ busy: true }) })), ['<b>El instalador está trabajando en otra ventana.</b>', 'Espera a que termine; Quorb lo detecta solo.'], 'es busy');
    expectAll(codex('es', codexState({ status: codexStatus({ supported: false }) })), ['<b>Este sistema no permite la instalación asistida.</b>', 'Está pensada para Windows; puedes instalarlo a mano y Quorb lo detectará.', 'Volver a comprobar', 'Copiar orden'], 'es unsupported');
    expectAll(codex('es', codexState({ status: codexStatus({ nodeAvailable: false }) })), ['<b>No se detecta Node.js y npm.</b>', 'Quorb solo comprueba que existan; la versión (Node.js 22 o superior) la valida el instalador al confirmar. Instálalos y vuelve a comprobar.'], 'es no-node');
    expectAll(
      codex('es', codexState({ error: 'boom', errorFrom: 'read' })),
      ['<b>No se pudo consultar el instalador.</b>', 'boom', 'Vuelve a comprobar el estado.'],
      'es error read',
    );
    expectAll(codex('es', codexState({ error: 'boom', errorFrom: 'install' })), ['<b>No se pudo instalar Codex CLI.</b>', 'Puedes reintentarlo.'], 'es error install');
    expectAll(
      codex('es', codexState({ status: codexStatus({}) })),
      ['Paquete fijado: <code>@openai/codex@0.162.1</code> desde el registro oficial de npm. No se instala «la última».', 'Carpeta de destino: <code>%USERPROFILE%\\…\\tools\\codex-0.162.1</code>, dentro de la carpeta de Quorb. No se toca el npm global ni las variables de entorno.', 'Se ignoran los scripts de ciclo de vida del paquete y se valida la versión real antes de darlo por bueno.'],
      'es details',
    );
  });

  it('renders every view in English and drops the Spanish literals', () => {
    const loading = codex('en', codexState({}));
    expectAll(loading, ['<b>Checking Codex CLI…</b>', 'Quorb only checks the state of this machine.'], 'en loading');
    expectNone(loading, ['Comprobando Codex CLI', 'consulta el estado'], 'en loading');
    const ready = codex('en', codexState({ status: codexStatus({}) }));
    expectAll(ready, ['<b>Codex CLI is missing on this machine.</b>', 'Install Codex', 'What exactly it installs'], 'en ready');
    expectNone(ready, ['Falta Codex CLI', 'Instalar Codex<'], 'en ready');
    expectAll(codex('en', codexState({ installing: true })), ['<b>Installing Codex CLI…</b>', 'Installing…'], 'en installing');
    expectAll(codex('en', codexState({ outcome: 'cancelled' })), ['<b>Installation cancelled.</b>', 'Nothing was changed. You can try again.', 'Retry'], 'en cancelled');
    expectAll(codex('en', codexState({ status: codexStatus({ supported: false }) })), ['<b>This system does not support assisted installation.</b>', 'Check again', 'Copy command'], 'en unsupported');
    expectAll(codex('en', codexState({ status: codexStatus({ nodeAvailable: false }) })), ['<b>Node.js and npm are not detected.</b>'], 'en no-node');
    expectAll(codex('en', codexState({ error: 'boom', errorFrom: 'read' })), ['<b>The installer could not be queried.</b>', 'boom', 'Check the state again.'], 'en error read');
    expectAll(codex('en', codexState({ error: 'boom', errorFrom: 'install' })), ['<b>Codex CLI could not be installed.</b>', 'You can retry.'], 'en error install');
  });
});
