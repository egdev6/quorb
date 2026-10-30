// Corte visible de i18n para los paneles de suscripción de Ajustes › Proveedores
// (#66, T2c slice 2 C1b): Claude, Codex, Gemini, Grok, Cursor, GitHub Copilot,
// MiniMax, z.ai y OpenCode Go, renderizados en servidor (renderToStaticMarkup,
// sin DOM falso) con los literales exactos: en español tal y como estaban en el
// código y en inglés tras la migración.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CodexInstallController } from './lib/codex-install';
import type { AppConfig, Locale } from './lib/types';
import {
  CopilotPanel,
  CursorPanel,
  MiniMaxPanel,
  OpenCodeGoPanel,
  SubscriptionPanel,
  ZaiPanel,
} from './Settings';

const noop = () => {};

const expectAll = (html: string, texts: string[], label: string) => {
  for (const text of texts) expect(html, `falta «${text}» en ${label}`).toContain(text);
};
const expectNone = (html: string, texts: string[], label: string) => {
  for (const text of texts) expect(html, `sobra «${text}» en ${label}`).not.toContain(text);
};

// Config mínima: solo lo que leen los paneles de suscripción.
const sub = (loginCommand: string) => ({ enabled: true, loginCommand, credentialsPath: null });
const cfg = {
  hiddenProviders: [],
  claude: sub('claude'),
  codex: sub('codex'),
  gemini: sub('gemini'),
  grok: sub('grok'),
  cursor: { enabled: true, credentialsPath: null },
  copilot: { enabled: true, username: '', plan: 'pro', customAllowance: null },
  minimax: { enabled: true, baseUrl: 'https://api.minimax.io' },
  zai: { enabled: true },
  opencodeGo: { enabled: true },
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

// `CodexInstall` (C2) solo se pinta con `codex` y el CLI ausente: estos paneles no lo usan.
const codexInstall = {} as CodexInstallController;

const common = (locale: Locale) => ({
  locale,
  cfg,
  secrets: {},
  set: noop,
  setVisibility: noop,
  loadSecrets: noop,
  healthFor: healthFor(locale),
});

const subscription = (locale: Locale, p: 'claude' | 'codex' | 'gemini' | 'grok', cli: Record<string, boolean> = {}) =>
  renderToStaticMarkup(<SubscriptionPanel {...common(locale)} p={p} cli={cli} codexInstall={codexInstall} onCodexRecheck={noop} />);
const cursor = (locale: Locale) => renderToStaticMarkup(<CursorPanel {...common(locale)} />);
const copilot = (locale: Locale, plan = 'pro') =>
  renderToStaticMarkup(<CopilotPanel {...common(locale)} cfg={{ ...cfg, copilot: { ...cfg.copilot, plan } } as AppConfig} />);
const minimax = (locale: Locale) => renderToStaticMarkup(<MiniMaxPanel {...common(locale)} />);
const zai = (locale: Locale) => renderToStaticMarkup(<ZaiPanel {...common(locale)} />);
const opencodeGo = (locale: Locale) => renderToStaticMarkup(<OpenCodeGoPanel {...common(locale)} />);

describe('Subscription provider panels (SSR, i18n)', () => {
  it('renders the Spanish literals of Claude, Codex, Gemini and Grok copied verbatim from the current code', () => {
    expectAll(
      subscription('es', 'claude'),
      [
        'Suscripción · OAuth',
        'Claude (Pro / Max)',
        'Mostrar en el widget',
        'Límites de sesión (5 h), semanales y por modelo de tu plan. Quorb lee la sesión que guarda Claude Code: no ve tu contraseña ni toca los tokens.',
        'aria-label="Cómo conectar la cuenta"',
        'Avanzado · fichero de sesión y comando de login',
        'Fichero de credenciales',
        String.raw`Vacío = <code>%USERPROFILE%\.claude\.credentials.json</code>. Para WSL: <code>\\wsl.localhost\Ubuntu\home\TU_USUARIO\.claude\.credentials.json</code>`,
        'Comando de login',
        // pasos de CliConnect (C1a), pintados dentro del panel
        '<b>Inicia sesión</b>',
        'Comprobando la conexión…',
      ],
      'es claude',
    );
    expectAll(
      subscription('es', 'codex'),
      [
        'Suscripción · OAuth',
        'ChatGPT (Plus / Pro · Codex)',
        'Límites de 5 h y semanales de tu plan de ChatGPT en Codex. Quorb lee la sesión que guarda el CLI de Codex.',
        'Fichero auth.json',
        String.raw`Vacío = <code>%CODEX_HOME%</code> o <code>%USERPROFILE%\.codex\auth.json</code>`,
      ],
      'es codex',
    );
    expectAll(
      subscription('es', 'gemini'),
      [
        'Suscripción · sesión de Gemini CLI',
        'Gemini (Google AI Pro / Code Assist)',
        'Cuotas diarias por modelo. Quorb lee la sesión que guarda <a ',
        'Gemini CLI</a>. Endpoints no oficiales.',
        'Fichero de credenciales',
        String.raw`Vacío = <code>%USERPROFILE%\.gemini\oauth_creds.json</code>`,
      ],
      'es gemini',
    );
    expectAll(
      subscription('es', 'grok'),
      [
        'Suscripción · OAuth',
        'Grok (SuperGrok)',
        'Uso semanal de créditos de tu suscripción en el CLI de Grok. Quorb lee la sesión que guarda <code>grok login</code>. Endpoint no oficial.',
        'Fichero auth.json',
        String.raw`Vacío = <code>%GROK_HOME%</code> o <code>%USERPROFILE%\.grok\auth.json</code>`,
      ],
      'es grok',
    );
  });

  it('renders the English texts of Claude, Codex, Gemini and Grok when the locale is en, with no Spanish left', () => {
    const claude = subscription('en', 'claude');
    expectAll(
      claude,
      [
        'Subscription · OAuth',
        'Claude (Pro / Max)',
        'Show in the widget',
        'Session (5 h), weekly and per-model limits of your plan. Quorb reads the session that Claude Code stores: it does not see your password or touch the tokens.',
        'aria-label="How to connect the account"',
        'Advanced · session file and login command',
        'Credentials file',
        String.raw`Empty = <code>%USERPROFILE%\.claude\.credentials.json</code>. For WSL: <code>\\wsl.localhost\Ubuntu\home\YOUR_USER\.claude\.credentials.json</code>`,
        'Login command',
        '<b>Sign in</b>',
        'Checking the connection…',
      ],
      'en claude',
    );
    const codex = subscription('en', 'codex');
    expectAll(
      codex,
      [
        'ChatGPT (Plus / Pro · Codex)',
        'The 5 h and weekly limits of your ChatGPT plan in Codex. Quorb reads the session that the Codex CLI stores.',
        'auth.json file',
        String.raw`Empty = <code>%CODEX_HOME%</code> or <code>%USERPROFILE%\.codex\auth.json</code>`,
      ],
      'en codex',
    );
    const gemini = subscription('en', 'gemini');
    expectAll(
      gemini,
      [
        'Subscription · Gemini CLI session',
        'Daily per-model quotas. Quorb reads the session stored by <a ',
        'Gemini CLI</a>. Unofficial endpoints.',
        'Credentials file',
        String.raw`Empty = <code>%USERPROFILE%\.gemini\oauth_creds.json</code>`,
      ],
      'en gemini',
    );
    const grok = subscription('en', 'grok');
    expectAll(
      grok,
      [
        'Weekly credit usage of your subscription in the Grok CLI. Quorb reads the session stored by <code>grok login</code>. Unofficial endpoint.',
        'auth.json file',
        String.raw`Empty = <code>%GROK_HOME%</code> or <code>%USERPROFILE%\.grok\auth.json</code>`,
      ],
      'en grok',
    );
    expectNone(
      [claude, codex, gemini, grok].join('\n'),
      [
        'Suscripción',
        'Mostrar en el widget',
        'Límites',
        'Quorb lee',
        'Cuotas diarias',
        'Uso semanal',
        'Cómo conectar',
        'Avanzado',
        'Fichero',
        'Vacío',
        'Para WSL',
        'TU_USUARIO',
        'Comando de login',
        'no oficial',
        'Inicia sesión',
        'Comprobando',
      ],
      'en claude/codex/gemini/grok',
    );
  });

  it('renders the Spanish literals of Cursor copied verbatim from the current code', () => {
    expectAll(
      cursor('es'),
      [
        'Suscripción · sesión de la app',
        'Cursor',
        'Mostrar en el widget',
        'Uso del plan en el ciclo actual (total, Auto y modelos API) y gasto on-demand. Endpoint no oficial.',
        'aria-label="Cómo conectar la cuenta"',
        '<b>Inicia sesión en la app de Cursor</b>',
        'Quorb lee la sesión que guarda la app de Cursor en este equipo (solo lectura). Si no usas la app aquí, pega un token manual: tiene prioridad sobre la sesión de la app.',
        'Token manual (opcional)',
        'Comprobando la conexión…',
        'Avanzado · base de datos de Cursor',
        'Base de datos de Cursor',
        String.raw`Vacío = <code>%APPDATA%\Cursor\User\globalStorage\state.vscdb</code>`,
      ],
      'es cursor',
    );
  });

  it('renders the English texts of Cursor when the locale is en, with no Spanish left', () => {
    const html = cursor('en');
    expectAll(
      html,
      [
        'Subscription · app session',
        'Show in the widget',
        'Plan usage in the current cycle (total, Auto and API models) and on-demand spend. Unofficial endpoint.',
        'aria-label="How to connect the account"',
        '<b>Sign in to the Cursor app</b>',
        'Quorb reads the session that the Cursor app stores on this computer (read-only). If you do not use the app here, paste a manual token: it takes priority over the app session.',
        'Manual token (optional)',
        'Checking the connection…',
        'Advanced · Cursor database',
        'Cursor database',
        String.raw`Empty = <code>%APPDATA%\Cursor\User\globalStorage\state.vscdb</code>`,
      ],
      'en cursor',
    );
    expectNone(
      html,
      ['Suscripción', 'Mostrar en el widget', 'Uso del plan', 'Cómo conectar', 'Inicia sesión', 'Token manual', 'Avanzado', 'Base de datos', 'Vacío', 'no oficial', 'Comprobando'],
      'en cursor',
    );
  });

  it('renders the Spanish literals of GitHub Copilot copied verbatim from the current code', () => {
    const html = copilot('es');
    expectAll(
      html,
      [
        'Suscripción · API oficial',
        'GitHub Copilot',
        'Mostrar en el widget',
        'Peticiones premium del mes con la API de facturación de GitHub. Se reinician el día 1 (UTC).',
        'aria-label="Cómo conectar la cuenta"',
        '<b>Usuario y plan de GitHub</b>',
        'Usuario de GitHub',
        'Plan',
        'Otra cantidad',
        '<b>Token de solo lectura</b>',
        'Token de GitHub (fine-grained)',
        'Créalo en <a ',
        'GitHub › Fine-grained tokens</a> con el permiso de cuenta «Plan»: solo lectura.',
        'Comprobando la conexión…',
      ],
      'es copilot',
    );
    expect(html).not.toContain('Peticiones premium incluidas al mes');
    expect(copilot('es', 'custom')).toContain('Peticiones premium incluidas al mes');
  });

  it('renders the English texts of GitHub Copilot when the locale is en, with no Spanish left', () => {
    const html = copilot('en');
    expectAll(
      html,
      [
        'Subscription · Official API',
        'Show in the widget',
        'Premium requests of the month from the GitHub billing API. They reset on the 1st (UTC).',
        'aria-label="How to connect the account"',
        '<b>GitHub user and plan</b>',
        'GitHub username',
        'Other amount',
        '<b>Read-only token</b>',
        'GitHub token (fine-grained)',
        'Create it at <a ',
        'GitHub › Fine-grained tokens</a> with the “Plan” account permission: read-only.',
        'Checking the connection…',
      ],
      'en copilot',
    );
    expect(copilot('en', 'custom')).toContain('Premium requests included per month');
    expectNone(
      [html, copilot('en', 'custom')].join('\n'),
      ['Suscripción', 'Mostrar en el widget', 'Peticiones premium', 'Se reinician', 'Cómo conectar', 'Usuario', 'Otra cantidad', 'Token de', 'Créalo', 'permiso', 'Comprobando'],
      'en copilot',
    );
  });

  it('renders the Spanish literals of MiniMax copied verbatim from the current code', () => {
    expectAll(
      minimax('es'),
      [
        'Suscripción · API oficial',
        'MiniMax',
        'Mostrar en el widget',
        'Cuota del plan y, si añades la segunda clave, tu saldo de pago por uso. Son<b> dos credenciales distintas</b> en la consola: la primera da acceso al plan y la segunda al saldo.',
        'aria-label="Cómo conectar la cuenta"',
        '<b>Subscription Key del plan</b>',
        'Subscription Key',
        'Del panel M/Token en <a ',
        'minimax.io</a>. En la región de China, en <a ',
        'minimaxi.com</a> (el host por región se cambia en Ajustes avanzados).',
        '<b>API key de pago por uso (opcional)</b>',
        'API key PAYG',
        'Sin ella solo se muestra la cuota del plan; el saldo es opcional y su fallo no lo degrade.',
        'Comprobando la conexión…',
        'Avanzado · URL del API',
        'Base URL',
        'Las claves son por región: global en api.minimax.io, China en api.minimaxi.com. Si el anillo sale con error 1004 o 2049, prueba con la de tu región.',
      ],
      'es minimax',
    );
  });

  it('renders the English texts of MiniMax when the locale is en, with no Spanish left', () => {
    const html = minimax('en');
    expectAll(
      html,
      [
        'Subscription · Official API',
        'Show in the widget',
        'Plan quota and, if you add the second key, your pay-as-you-go balance. They are<b> two different credentials</b> in the console: the first gives access to the plan and the second to the balance.',
        'aria-label="How to connect the account"',
        '<b>Plan Subscription Key</b>',
        'From the M/Token panel at <a ',
        'minimax.io</a>. In mainland China, at <a ',
        'minimaxi.com</a> (the per-region host is changed in Advanced settings).',
        '<b>Pay-as-you-go API key (optional)</b>',
        'Without it only the plan quota is shown; the balance is optional and a failure there does not degrade it.',
        'Checking the connection…',
        'Advanced · API URL',
        'Keys are per region: global at api.minimax.io, China at api.minimaxi.com. If the ring shows error 1004 or 2049, try the one for your region.',
      ],
      'en minimax',
    );
    expectNone(
      html,
      ['Suscripción', 'Mostrar en el widget', 'Cuota del plan', 'dos credenciales', 'Cómo conectar', 'del plan', 'Del panel', 'región', 'pago por uso', 'Sin ella', 'Avanzado', 'Las claves', 'Comprobando'],
      'en minimax',
    );
  });

  it('renders the Spanish literals of z.ai and OpenCode Go copied verbatim from the current code', () => {
    expectAll(
      zai('es'),
      [
        'Suscripción · GLM Coding Plan',
        'z.ai',
        'Mostrar en el widget',
        'Cuotas de coding de las últimas 5 h y de la semana, y cuota mensual de web tools del Coding Plan.',
        'aria-label="Cómo conectar la cuenta"',
        '<b>API key</b>',
        'Créala en <a ',
        'z.ai › API Keys</a>.',
        'Comprobando la conexión…',
      ],
      'es zai',
    );
    expectAll(
      opencodeGo('es'),
      [
        'Suscripción · Go / Go Plus',
        'OpenCode Go',
        'Mostrar en el widget',
        'Cuota de las últimas 5 h, cuota semanal y cuota del ciclo de facturación de la suscripción Go / Go Plus.',
        'aria-label="Cómo conectar la cuenta"',
        '<b>API key</b>',
        'API key de OpenCode Go',
        'Créala en <a ',
        'OpenCode › Console</a>.',
        'Comprobando la conexión…',
      ],
      'es opencode_go',
    );
  });

  it('renders the English texts of z.ai and OpenCode Go when the locale is en, with no Spanish left', () => {
    const z = zai('en');
    const o = opencodeGo('en');
    expectAll(
      z,
      [
        'Subscription · GLM Coding Plan',
        'Show in the widget',
        'Coding quotas for the last 5 h and the week, and the monthly web tools quota of the Coding Plan.',
        'aria-label="How to connect the account"',
        '<b>API key</b>',
        'Create it at <a ',
        'z.ai › API Keys</a>.',
        'Checking the connection…',
      ],
      'en zai',
    );
    expectAll(
      o,
      [
        'Subscription · Go / Go Plus',
        'Show in the widget',
        'Quota for the last 5 h, weekly quota and billing-cycle quota of the Go / Go Plus subscription.',
        'aria-label="How to connect the account"',
        'OpenCode Go API key',
        'Create it at <a ',
        'OpenCode › Console</a>.',
        'Checking the connection…',
      ],
      'en opencode_go',
    );
    expectNone(
      [z, o].join('\n'),
      ['Suscripción', 'Mostrar en el widget', 'Cuotas', 'Cuota', 'Cómo conectar', 'API key de', 'Créala', 'Comprobando'],
      'en zai/opencode_go',
    );
  });
});
