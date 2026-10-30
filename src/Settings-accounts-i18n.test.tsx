// Corte visible de i18n para los pasos de conexión por CLI (`CliConnect`) y el
// editor de cuentas adicionales (`AccountEditor`) de Ajustes › Proveedores (#66,
// T2c slice 2 C1a), renderizados en servidor (renderToStaticMarkup, sin DOM
// falso) con los literales exactos: en español tal y como estaban en el código y
// en inglés tras la migración. También cubre `whereKey` de `CLI_INSTALL`: el
// aviso de `CliMissing` se traduce por clave, no comparando un texto español.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CLI_INSTALL, defaultSessionDir } from './lib/accounts';
import type { CodexInstallController } from './lib/codex-install';
import type { Account, AccountProvider, Locale } from './lib/types';
import { AccountEditor, CliConnectView, CliMissing } from './Settings';

const noop = () => {};

const expectAll = (html: string, texts: string[], label: string) => {
  for (const text of texts) expect(html, `falta «${text}» en ${label}`).toContain(text);
};
const expectNone = (html: string, texts: string[], label: string) => {
  for (const text of texts) expect(html, `sobra «${text}» en ${label}`).not.toContain(text);
};

const health = (locale: Locale, over: { dirty?: boolean } = {}) => ({
  saved: null,
  secretsSig: '',
  dirty: over.dirty ?? false,
  hidden: false,
  saving: false,
  onSave: () => Promise.resolve(true),
  locale,
});

// `CodexInstall` solo se pinta con `codex` y el CLI ausente; aquí no se usa.
const codexInstall = {} as CodexInstallController;

const connect = (
  locale: Locale,
  provider: 'claude' | 'gemini',
  over: { cliMissing?: boolean; persisted?: boolean; extra?: boolean; dirty?: boolean; connected?: boolean; loginError?: string | null } = {},
) =>
  renderToStaticMarkup(
    <CliConnectView
      locale={locale}
      id={provider}
      provider={provider}
      loginCommand={provider}
      cliMissing={over.cliMissing ?? false}
      persisted={over.persisted ?? false}
      extra={over.extra ?? false}
      health={health(locale, { dirty: over.dirty })}
      codexInstall={codexInstall}
      onCodexRecheck={noop}
      connected={over.connected ?? false}
      busy={false}
      loginError={over.loginError ?? null}
      onConnect={noop}
    />,
  );

describe('CliConnect steps (SSR, i18n)', () => {
  const states = (locale: Locale) => ({
    missingClaude: connect(locale, 'claude', { cliMissing: true }),
    claudeDirty: connect(locale, 'claude', { persisted: true, dirty: true }),
    claudeSaved: connect(locale, 'claude', { persisted: true }),
    geminiExtra: connect(locale, 'gemini', { extra: true, persisted: true }),
    geminiConnected: connect(locale, 'gemini', { persisted: true, connected: true, extra: true }),
    failed: connect(locale, 'claude', { persisted: true, loginError: 'boom' }),
  });

  it('renders the Spanish literals copied verbatim from the current code', () => {
    const s = states('es');
    expectAll(
      s.missingClaude,
      [
        '<b>Instala Claude Code</b>',
        'Hace falta para iniciar sesión y para renovarla cuando caduque, aunque ahora funcione.',
        'Falta Claude Code en este equipo.',
        '<b>Inicia sesión</b>',
        'Se abre una terminal con <code>claude</code> (si no te lo pide, escribe <code>/login</code>). El navegador hace el login oficial y el CLI guarda la sesión, que Quorb solo lee.',
        'Guardar e iniciar sesión',
        '<b>Comprobación</b>',
        'Se hace sola en cuanto guardes e inicies sesión.',
      ],
      'es',
    );
    expect(s.claudeDirty).toContain('Guardar e iniciar sesión');
    expectAll(s.claudeSaved, ['>Iniciar sesión</button>', 'Comprobando la conexión…'], 'es');
    expect(s.claudeSaved).not.toContain('Guardar e iniciar sesión');
    expectAll(
      s.geminiExtra,
      [
        '<b>Inicia sesión con la otra cuenta</b>',
        'Se abre una terminal con <code>gemini</code> (elige «Login with Google»). El navegador hace el login oficial y el CLI guarda la sesión, que Quorb solo lee.',
        ' Entra con la cuenta que quieres añadir, no con la principal: si el navegador ya tiene abierta la principal, usa una ventana privada.',
      ],
      'es',
    );
    expectAll(
      s.geminiConnected,
      [
        '<b>Fichero de sesión encontrado</b>',
        'que Quorb solo lee. El fichero existe, pero no confirma que la sesión siga siendo válida: míralo en la comprobación de abajo.',
        '>Volver a abrir el login</button>',
      ],
      'es',
    );
    expectAll(s.failed, ['boom'], 'es');
    expectNone(s.claudeSaved, ['Fichero de sesión encontrado', 'Entra con la cuenta'], 'es');
  });

  it('renders the English texts when the locale is en, with no Spanish left', () => {
    const s = states('en');
    expectAll(
      s.missingClaude,
      [
        '<b>Install Claude Code</b>',
        'It is needed to sign in and to renew the session when it expires, even if it works now.',
        'Claude Code is missing on this computer.',
        '<b>Sign in</b>',
        'A terminal opens with <code>claude</code> (if it does not ask, type <code>/login</code>). The browser does the official login and the CLI stores the session, which Quorb only reads.',
        'Save and sign in',
        '<b>Check</b>',
        'It runs on its own as soon as you save and sign in.',
      ],
      'en',
    );
    expect(s.claudeDirty).toContain('Save and sign in');
    expectAll(s.claudeSaved, ['>Sign in</button>', 'Checking the connection…'], 'en');
    expectAll(
      s.geminiExtra,
      [
        '<b>Sign in with the other account</b>',
        'A terminal opens with <code>gemini</code> (choose “Login with Google”).',
        ' Sign in with the account you want to add, not the main one: if the browser already has the main one open, use a private window.',
      ],
      'en',
    );
    expectAll(
      s.geminiConnected,
      [
        '<b>Session file found</b>',
        'which Quorb only reads. The file exists, but it does not confirm the session is still valid: check the verification below.',
        '>Open the login again</button>',
      ],
      'en',
    );
    expectNone(
      Object.values(s).join('\n'),
      [
        'Instala',
        'Hace falta',
        'Inicia sesión',
        'Iniciar sesión',
        'Se abre una terminal',
        'si no te lo pide',
        'elige',
        'Fichero',
        'El fichero existe',
        'Entra con la cuenta',
        'Volver a abrir',
        'Guardar e iniciar',
        'Comprobación',
        'Se hace sola',
        'su CLI',
      ],
      'en',
    );
  });
});

describe('AccountEditor (SSR, i18n)', () => {
  const account = (provider: AccountProvider, over: Partial<Account> = {}): Account =>
    ({
      id: `${provider}:b`,
      provider,
      label: 'Mi cuenta',
      enabled: true,
      configDir: null,
      username: 'egdev6',
      plan: '',
      customAllowance: null,
      monthlyBudgetUsd: null,
      ...over,
    }) as Account;

  const editor = (locale: Locale, a: Account, persisted = false) =>
    renderToStaticMarkup(
      <AccountEditor
        locale={locale}
        account={a}
        visible
        onVisibility={noop}
        persisted={persisted}
        secrets={{}}
        onChange={noop}
        onRemove={noop}
        onSecrets={noop}
        loginCommand="claude"
        cliMissing={false}
        health={health(locale)}
        codexInstall={codexInstall}
        onCodexRecheck={noop}
      />,
    );

  const claude = account('claude');
  const dir = defaultSessionDir(claude, null);

  it('renders the Spanish literals copied verbatim from the current code', () => {
    const base = editor('es', claude);
    expectAll(
      base,
      [
        '>Cuenta adicional</p>',
        '<h2>Mi cuenta</h2>',
        'Nombre',
        'Se ve en la tira junto al proveedor.',
        'Mostrar en el widget',
        'aria-label="Cómo conectar esta cuenta"',
        '<b>Ponle nombre</b>',
        'Arriba, para distinguirla de la principal en la tira (por ejemplo, «Trabajo»).',
        '<b>Comprobación</b>',
        'Avanzado · carpeta de sesión',
        'Eliminar esta cuenta',
        'Al guardar se borran también sus claves del almacén seguro del sistema.',
      ],
      'es',
    );
    expectAll(
      base,
      [
        'Cada cuenta guarda su sesión en su propia carpeta, así no toca la principal: el login se abre con <code>CLAUDE_CONFIG_DIR</code> apuntando a ella. Si la comprobación pide renovar la sesión, «Volver a abrir el login» abre de nuevo el CLI.',
        'Carpeta de sesión',
        `Vacío = <code>${dir}</code>. Puedes usar una que ya tengas. Quorb lee <code>.credentials.json</code> dentro de ella.`,
      ],
      'es',
    );
    // Cuenta sin guardar: el paso de comprobación pide guardar; guardada, comprueba.
    expectAll(editor('es', account('openrouter')), ['Guarda la cuenta para comprobar que funciona.', 'Guardar y comprobar'], 'es');
    expect(editor('es', account('openrouter'), true)).not.toContain('Guarda la cuenta para comprobar');

    expectAll(
      editor('es', account('cursor')),
      [
        '<b>Pega el token de esta cuenta</b>',
        'La app de Cursor guarda una sola sesión (la principal). Entra en cursor.com con esta cuenta y copia la cookie WorkosCursorSessionToken.',
        'Token de la cuenta',
      ],
      'es',
    );
    const copilot = editor('es', account('copilot', { plan: 'custom' }));
    expectAll(
      copilot,
      [
        '<b>Usuario y plan de GitHub</b>',
        'Usuario de GitHub',
        'Plan',
        '>Free · 50<',
        '>Pro · 300<',
        '>Pro+ · 1500<',
        '>Business · 300<',
        '>Enterprise · 1000<',
        '>Otra cantidad<',
        'Peticiones premium incluidas al mes',
        '<b>Token de solo lectura</b>',
        'Token de GitHub de esta cuenta (fine-grained)',
        'Créalo con esta cuenta en <a href=',
        '>GitHub › Fine-grained tokens</a> con el permiso «Plan» (solo lectura).',
      ],
      'es',
    );
    expectAll(
      editor('es', account('nan')),
      [
        '<b>Conecta la cuenta o pega una API key</b>',
        'API key (alternativa)',
        '<b>Plan</b>',
        'La URL base y el resto de ajustes avanzados son los de la cuenta principal.',
        '>nan_community<',
        '>nan_member<',
        '>GLM Premium<',
      ],
      'es',
    );
    expectAll(
      editor('es', account('openrouter')),
      ['<b>API key</b>', 'Puede ser de otra cuenta o de la misma con otro límite. <a href=', '>openrouter.ai › Keys</a>'],
      'es',
    );
    expectAll(editor('es', account('zai')), ['<b>API key</b>', 'Créala en <a href=', '>z.ai › API Keys</a>.'], 'es');
    expectAll(
      editor('es', account('opencode_go')),
      ['API key de OpenCode Go', 'Créala en <a href=', '>OpenCode › Console</a>.'],
      'es',
    );
    expectAll(
      editor('es', account('anthropic_api')),
      [
        '<b>Admin key de esta organización</b>',
        'Admin key',
        'Cada organización tiene su propia <a href=',
        '>Admin key</a>.',
        '<b>Presupuesto mensual (opcional)</b>',
        'USD al mes',
      ],
      'es',
    );
  });

  it('renders the English texts when the locale is en, with no Spanish left', () => {
    const base = editor('en', claude);
    expectAll(
      base,
      [
        '>Additional account</p>',
        '<h2>Mi cuenta</h2>',
        'Name',
        'Shown on the strip next to the provider.',
        'Show in the widget',
        'aria-label="How to connect this account"',
        '<b>Name it</b>',
        'Above, to tell it apart from the main one on the strip (for example, “Work”).',
        '<b>Check</b>',
        'Advanced · session folder',
        'Remove this account',
        'Saving also deletes its keys from the system secure store.',
        'Each account keeps its session in its own folder, so it does not touch the main one: the login opens with <code>CLAUDE_CONFIG_DIR</code> pointing to it. If the check asks you to renew the session, “Open the login again” opens the CLI again.',
        'Session folder',
        `Empty = <code>${dir}</code>. You can use one you already have. Quorb reads <code>.credentials.json</code> inside it.`,
      ],
      'en',
    );
    const openrouter = editor('en', account('openrouter'));
    expectAll(openrouter, ['Save the account to check that it works.', 'Save and check'], 'en');

    const cursor = editor('en', account('cursor'));
    expectAll(
      cursor,
      [
        '<b>Paste this account token</b>',
        'The Cursor app stores a single session (the main one). Sign in at cursor.com with this account and copy the WorkosCursorSessionToken cookie.',
        'Account token',
      ],
      'en',
    );
    const copilot = editor('en', account('copilot', { plan: 'custom' }));
    expectAll(
      copilot,
      [
        '<b>GitHub user and plan</b>',
        'GitHub username',
        'Plan',
        '>Free · 50<',
        '>Pro · 300<',
        '>Pro+ · 1500<',
        '>Business · 300<',
        '>Enterprise · 1000<',
        '>Other amount<',
        'Premium requests included per month',
        '<b>Read-only token</b>',
        'GitHub token for this account (fine-grained)',
        'Create it with this account at <a href=',
        '>GitHub › Fine-grained tokens</a> with the “Plan” permission (read-only).',
      ],
      'en',
    );
    const nan = editor('en', account('nan'));
    expectAll(
      nan,
      [
        '<b>Connect the account or paste an API key</b>',
        'API key (alternative)',
        '<b>Plan</b>',
        'The base URL and the other advanced settings are those of the main account.',
        '>nan_community<',
        '>nan_member<',
        '>GLM Premium<',
      ],
      'en',
    );
    const zai = editor('en', account('zai'));
    expectAll(openrouter, ['<b>API key</b>', 'It can be from another account or from the same one with a different limit. <a href=', '>openrouter.ai › Keys</a>'], 'en');
    expectAll(zai, ['<b>API key</b>', 'Create it at <a href=', '>z.ai › API Keys</a>.'], 'en');
    const opencode = editor('en', account('opencode_go'));
    expectAll(opencode, ['OpenCode Go API key', 'Create it at <a href=', '>OpenCode › Console</a>.'], 'en');
    const admin = editor('en', account('anthropic_api'));
    expectAll(
      admin,
      [
        '<b>Admin key for this organization</b>',
        'Each organization has its own <a href=',
        '>Admin key</a>.',
        '<b>Monthly budget (optional)</b>',
        'USD per month',
      ],
      'en',
    );
    // NanConnect y el resto de paneles siguen en español hasta C2 (fuera de este
    // corte): solo se comprueba lo que pinta `AccountEditor` en sí.
    expectNone(
      [base, openrouter, cursor, copilot, nan, zai, opencode, admin].join('\n'),
      [
        'Cuenta adicional',
        'Nombre',
        'Se ve en la tira',
        'Mostrar en el widget',
        'Cómo conectar',
        'Ponle nombre',
        'Trabajo',
        'Comprobación',
        'Guarda la cuenta',
        'Guardar y comprobar',
        'Avanzado',
        'Cada cuenta guarda',
        'Carpeta de sesión',
        'Vacío',
        'Puedes usar',
        'dentro de ella',
        'Eliminar esta cuenta',
        'Al guardar se borran',
        'Pega el token',
        'La app de Cursor',
        'Token de',
        'Usuario',
        'Otra cantidad',
        'Peticiones premium',
        'solo lectura',
        'Créalo',
        'Créala',
        'Conecta la cuenta',
        '(alternativa)',
        'La URL base',
        'Puede ser de otra cuenta',
        'API key de OpenCode',
        'Admin key de esta',
        'Cada organización',
        'Presupuesto mensual',
        'USD al mes',
      ],
      'en',
    );
  });
});

describe('CLI_INSTALL.whereKey (CliMissing, i18n)', () => {
  const missing = (locale: Locale, provider: 'claude' | 'codex' | 'gemini') => renderToStaticMarkup(<CliMissing provider={provider} locale={locale} />);

  it('translates the terminal phrase through whereKey for codex and gemini', () => {
    for (const provider of ['codex', 'gemini'] as const) {
      expect(CLI_INSTALL[provider]?.whereKey, provider).toBe('settings.providers.cliMissing.terminal');
      expectAll(missing('es', provider), ['Instálalo desde una terminal (necesita Node.js);'], `es ${provider}`);
      expectAll(missing('en', provider), ['Install it from a terminal (needs Node.js);'], `en ${provider}`);
      expectNone(missing('en', provider), ['una terminal', 'Instálalo'], `en ${provider}`);
    }
  });

  it('keeps PowerShell literal for claude, with no whereKey', () => {
    expect(CLI_INSTALL.claude?.whereKey).toBeUndefined();
    expect(CLI_INSTALL.claude?.where).toBe('PowerShell');
    expectAll(missing('es', 'claude'), ['Instálalo desde PowerShell; Quorb'], 'es');
    expectAll(missing('en', 'claude'), ['Install it from PowerShell; Quorb'], 'en');
  });

  it('does not depend on the Spanish text of the install data', () => {
    const gemini = CLI_INSTALL.gemini as { where?: string };
    const before = gemini.where;
    gemini.where = 'otra cosa';
    try {
      expectAll(missing('en', 'gemini'), ['Install it from a terminal (needs Node.js);'], 'en');
      expectNone(missing('en', 'gemini'), ['otra cosa'], 'en');
    } finally {
      if (before === undefined) delete gemini.where;
      else gemini.where = before;
    }
  });
});
