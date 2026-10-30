// Corte visible de i18n para la página «Proveedores» de Ajustes (#66, T2c slice 2
// PR-B): lista de proveedores, cabeceras, pie de guardado, avisos globales,
// navegación y el paso de comprobación (HealthStep, healthSummary, CliMissing),
// renderizados en servidor (renderToStaticMarkup, sin DOM falso) con los
// literales exactos: en español tal y como están hoy en el código y en inglés
// tras la migración. Los paneles por proveedor van en PR-C.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Account, AppConfig, Locale, UsageReport } from './lib/types';
import type { WindowManagerInfo } from './lib/wm-detect';
import {
  AccountsBar,
  AutostartNotice,
  AutostartSwitch,
  CliMissing,
  DesktopSessionNotice,
  HealthStepView,
  ProviderDrawerHead,
  ProvidersCard,
  SettingsFoot,
  SettingsHeadTitles,
  SettingsNav,
  healthSummary,
  type Health,
} from './Settings';

const noop = () => {};

/** Comprueba que todos los textos están (y, en en, que no queda español). */
const expectAll = (html: string, texts: string[], label: string) => {
  for (const text of texts) expect(html, `falta «${text}» en ${label}`).toContain(text);
};
const expectNone = (html: string, texts: string[], label: string) => {
  for (const text of texts) expect(html, `sobra «${text}» en ${label}`).not.toContain(text);
};

// Config mínima: solo lo que leen `providerState`/`mainState` y la lista.
const enabledOnly = (...ids: string[]) => {
  const on = (id: string) => ({ enabled: ids.includes(id), username: 'egdev6' });
  return {
    refreshMinutes: 5,
    claude: on('claude'),
    codex: on('codex'),
    gemini: on('gemini'),
    grok: on('grok'),
    cursor: on('cursor'),
    copilot: on('copilot'),
    nan: on('nan'),
    openrouter: on('openrouter'),
    minimax: on('minimax'),
    anthropicApi: on('anthropic_api'),
    openaiApi: on('openai_api'),
    nineRouter: on('nine_router'),
    zai: on('zai'),
    opencodeGo: on('opencode_go'),
    accounts: [{ id: 'claude:b', provider: 'claude', label: 'Cuenta 2', enabled: true }],
  } as unknown as AppConfig;
};

// claude: activo con 1 cuenta extra · copilot: activo sin token (falta conectar) · resto desactivados.
const cfg = enabledOnly('claude', 'copilot');

const card = (locale: Locale, tab: 'claude' | 'copilot' = 'claude', drawerOpen = true) =>
  renderToStaticMarkup(
    <ProvidersCard locale={locale} cfg={cfg} secrets={{}} tab={tab} drawerOpen={drawerOpen} onSelectTab={noop} onRefreshMinutes={noop} />,
  );

const descriptions: [es: string, en: string][] = [
  ['Pro / Max · sesión de 5 h, semanal y por modelo', 'Pro / Max · 5 h session, weekly and per-model'],
  ['Plus / Pro · sesión y semanal de Codex', 'Plus / Pro · Codex session and weekly'],
  ['Cuota diaria por modelo', 'Daily quota per model'],
  ['Uso del plan en el ciclo y on-demand', 'Plan usage in the cycle and on-demand'],
  ['SuperGrok · uso semanal de créditos del CLI', 'SuperGrok · weekly CLI credit usage'],
  ['Peticiones premium del mes', 'Premium requests of the month'],
  ['Cuota del plan M/Token y saldo de pago por uso', 'M/Token plan quota and pay-as-you-go balance'],
  ['Cuota del plan y tokens por día', 'Plan quota and tokens per day'],
  ['Saldo y gasto por clave', 'Balance and spend per key'],
  ['Gasto del mes con clave de admin', 'Month spend with an admin key'],
  ['Pasarela local · uso y gasto agregados', 'Local gateway · aggregated usage and spend'],
  ['GLM Coding Plan · cuotas de 5 h, semanales y web tools', 'GLM Coding Plan · 5 h, weekly quotas and web tools'],
  ['Go / Go Plus · cuotas de 5 h, semanal y ciclo de facturación', 'Go / Go Plus · 5 h, weekly and billing-cycle quotas'],
];

describe('Providers list: tab descriptions and badges (SSR, i18n)', () => {
  it('renders the Spanish literals copied verbatim from the current code', () => {
    const html = card('es');
    expectAll(html, descriptions.map(([es]) => es), 'es');
    expectAll(html, ['ChatGPT y Codex', 'Claude', 'GitHub Copilot', 'NaN Builders', '9Router', 'z.ai'], 'es');
    expectAll(html, ['Activo', 'Falta conectar', 'Desactivado', 'Conectar', 'Configurar', ' · 2 cuentas'], 'es');
  });

  it('renders the English texts when the locale is en, with no Spanish left', () => {
    const html = card('en');
    expectAll(html, descriptions.map(([, en]) => en), 'en');
    // «ChatGPT y Codex» es el único nombre con una conjunción española; el resto son marcas.
    expectAll(html, ['ChatGPT and Codex', 'Claude', 'GitHub Copilot', 'NaN Builders', '9Router', 'z.ai'], 'en');
    expectAll(html, ['Active', 'Needs connecting', 'Disabled', 'Connect', 'Set up', ' · 2 accounts'], 'en');
    expectNone(
      html,
      [...descriptions.map(([es]) => es), 'ChatGPT y Codex', 'Activo', 'Falta conectar', 'Desactivado', 'Conectar', 'Configurar', 'cuentas'],
      'en',
    );
  });
});

describe('PAGES labels, titles and nav chrome (SSR, i18n)', () => {
  const nav = (locale: Locale, collapsed = false) =>
    renderToStaticMarkup(
      <SettingsNav
        appName="Quorb"
        section="providers"
        locale={locale}
        navCollapsed={collapsed}
        onSelectSection={noop}
        onToggleNav={noop}
        pendingProviders={2}
        shortcutErrors={[]}
        shortcutWarnings={[]}
      />,
    );
  const head = (locale: Locale) => renderToStaticMarkup(<SettingsHeadTitles locale={locale} section="providers" />);

  it('renders the Spanish literals copied verbatim from the current code', () => {
    const html = nav('es') + nav('es', true) + head('es');
    expectAll(
      html,
      [
        'Proveedores',
        'Apariencia',
        'Alertas',
        'Atajos',
        'Actualizaciones',
        'Suscripciones y APIs',
        'Qué se consulta y cómo se conecta cada proveedor.',
        'aria-label="Secciones de ajustes"',
        'title="Activos pero sin configurar"',
        'aria-label="Expandir el menú"',
        'title="Expandir el menú"',
        'Contraer',
      ],
      'es',
    );
    expectAll(nav('es'), ['aria-label="Contraer el menú"', 'title="Contraer el menú"'], 'es');
  });

  it('renders the English texts when the locale is en, with no Spanish left', () => {
    const html = nav('en') + nav('en', true) + head('en');
    expectAll(
      html,
      [
        'Providers',
        'Appearance',
        'Alerts',
        'Shortcuts',
        'Updates',
        'Subscriptions &amp; APIs',
        'What gets checked and how each provider connects.',
        'aria-label="Settings sections"',
        'title="Active but not set up"',
        'aria-label="Expand the menu"',
        'title="Expand the menu"',
        'Collapse',
      ],
      'en',
    );
    expectAll(nav('en'), ['aria-label="Collapse the menu"', 'title="Collapse the menu"'], 'en');
    expectNone(
      html,
      ['Proveedores', 'Suscripciones y APIs', 'Secciones de ajustes', 'Activos pero sin configurar', 'Expandir el menú', 'Contraer'],
      'en',
    );
  });
});

describe('Providers shell: headings, drawer and accounts (SSR, i18n)', () => {
  const drawerHead = (locale: Locale) =>
    renderToStaticMarkup(<ProviderDrawerHead locale={locale} tab="copilot" state="warn" onClose={noop} />);
  const accounts: Account[] = [{ id: 'claude:b', provider: 'claude', label: 'Cuenta 2', enabled: true } as Account];
  const bar = (locale: Locale, tab: 'claude' | 'nine_router') =>
    renderToStaticMarkup(<AccountsBar locale={locale} tab={tab} accounts={accounts} selectedId={tab} onSelect={noop} onAdd={noop} />);

  it('renders the Spanish literals copied verbatim from the current code', () => {
    expectAll(
      card('es'),
      [
        'aria-label="Proveedores"',
        '<h2>Proveedores</h2>',
        'Consultar cada',
        'min',
        'Suscripciones',
        'APIs y créditos',
        'Para cambiar el orden de los anillos, arrástralos en la tira.',
      ],
      'es',
    );
    expectAll(drawerHead('es'), ['Configuración', 'Cerrar la configuración', 'Falta conectar', 'GitHub Copilot'], 'es');
    expectAll(bar('es', 'claude'), ['aria-label="Cuentas"', 'Principal', '+ Añadir cuenta', 'Cuenta 2'], 'es');
    expectAll(
      bar('es', 'nine_router'),
      ['Los subproveedores de 9Router se descubren solos desde su historial de uso; no se añaden a mano.'],
      'es',
    );
    expect(bar('es', 'nine_router')).not.toContain('Añadir cuenta');
  });

  it('renders the English texts when the locale is en, with no Spanish left', () => {
    const html = card('en') + drawerHead('en') + bar('en', 'claude') + bar('en', 'nine_router');
    expectAll(card('en'), ['aria-label="Providers"', '<h2>Providers</h2>', 'Check every', 'min', 'Subscriptions', 'APIs and credits', 'To change the order of the rings, drag them on the strip.'], 'en');
    expectAll(drawerHead('en'), ['Configuration', 'Close the configuration', 'Needs connecting', 'GitHub Copilot'], 'en');
    expectAll(bar('en', 'claude'), ['aria-label="Accounts"', 'Main', '+ Add account'], 'en');
    expectAll(
      bar('en', 'nine_router'),
      ['The 9Router sub-providers are discovered automatically from its usage history; they are not added by hand.'],
      'en',
    );
    expectNone(
      html,
      [
        'Proveedores',
        'Consultar cada',
        'Suscripciones',
        'APIs y créditos',
        'arrástralos',
        'Configuración',
        'Cerrar la configuración',
        'Falta conectar',
        'Cuentas',
        'Principal',
        'Añadir cuenta',
        'subproveedores',
      ],
      'en',
    );
  });
});

describe('Save bar, unsaved changes and global notices (SSR, i18n)', () => {
  const foot = (locale: Locale, variant: 'drawer' | 'window', saving = false, dirty = true) =>
    renderToStaticMarkup(<SettingsFoot locale={locale} variant={variant} saved="Guardado ✓" dirty={dirty} saving={saving} onSave={noop} onClose={noop} />);
  const wm = {
    waylandDisplay: null,
    xdgSessionType: 'x11',
    desktopSession: 'gnome',
    xdgCurrentDesktop: null,
    isWayland: true,
    isHyprland: false,
    recommendation: 'texto del backend',
    surfaces: Object.fromEntries(
      ['alwaysOnTop', 'clickThrough', 'trayIcon', 'globalShortcuts', 'autostart', 'notifications', 'transparency', 'windowPositioning'].map((k, i) => [
        k,
        { state: i % 2 ? 'limited' : 'ok', note: 'nota del backend' },
      ]),
    ),
  } as unknown as WindowManagerInfo;

  it('renders the Spanish literals copied verbatim from the current code', () => {
    expectAll(foot('es', 'drawer'), ['q-drawer__foot', 'Listo', 'Guardar cambios', 'Guardado ✓'], 'es');
    expectAll(foot('es', 'window'), ['q-foot', 'Cerrar', 'Guardar cambios'], 'es');
    expectAll(foot('es', 'window', true), ['Guardando…'], 'es');
    expect(foot('es', 'drawer')).not.toContain('Cerrar');
    expect(foot('es', 'window')).not.toContain('Listo');

    expect(renderToStaticMarkup(<AutostartSwitch locale="es" checked disabled={false} onChange={noop} />)).toContain('Arrancar al iniciar sesión');
    const unread = renderToStaticMarkup(<AutostartNotice locale="es" error="fallo" unread busy={false} onRetry={noop} />);
    expectAll(unread, ['No se pudo leer «Arrancar al iniciar sesión»: ', 'fallo', 'Reintentar'], 'es');
    const readable = renderToStaticMarkup(<AutostartNotice locale="es" error="fallo" unread={false} busy={false} onRetry={noop} />);
    expect(readable).toContain('fallo');
    expect(readable).not.toContain('Reintentar');
    expectAll(renderToStaticMarkup(<DesktopSessionNotice locale="es" wmInfo={wm} />), ['Sesión de escritorio: Wayland', ' · gnome', 'con límites:', 'sin límites conocidos:', 'texto del backend', 'nota del backend'], 'es');
  });

  it('renders the English texts when the locale is en, with no Spanish left', () => {
    const html =
      foot('en', 'drawer') +
      foot('en', 'window') +
      foot('en', 'window', true) +
      renderToStaticMarkup(<AutostartSwitch locale="en" checked disabled={false} onChange={noop} />) +
      renderToStaticMarkup(<AutostartNotice locale="en" error="fallo" unread busy={false} onRetry={noop} />) +
      renderToStaticMarkup(<DesktopSessionNotice locale="en" wmInfo={wm} />);
    expectAll(foot('en', 'drawer'), ['Done', 'Save changes'], 'en');
    expectAll(foot('en', 'window'), ['Close', 'Save changes'], 'en');
    expectAll(foot('en', 'window', true), ['Saving…'], 'en');
    expect(foot('en', 'drawer')).not.toContain('Close');
    expect(foot('en', 'window')).not.toContain('Done');
    expectAll(
      html,
      ['Start at login', 'Could not read “Start at login”: ', 'Retry', 'Desktop session: Wayland', ' · gnome', 'with limits:', 'no known limits:', 'texto del backend'],
      'en',
    );
    expectNone(
      html.replace('texto del backend', '').replace(/nota del backend/g, ''),
      ['Listo', 'Cerrar', 'Guardar cambios', 'Guardando', 'Arrancar al iniciar sesión', 'No se pudo leer', 'Reintentar', 'Sesión de escritorio', 'con límites', 'sin límites conocidos'],
      'en',
    );
  });
});

describe('HealthStep, healthSummary and CliMissing (SSR, i18n)', () => {
  const report = (over: Partial<UsageReport>): UsageReport => ({
    id: 'claude',
    name: 'Claude',
    kind: 'subscription',
    status: 'ok',
    plan: null,
    meters: [],
    spend: null,
    message: null,
    action: null,
    fetchedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as UsageReport);
  const meter = (percent: number | null) => ({ id: 'five_hour', label: 'Sesión 5 h', percent, used: null, limit: null, unit: null, resetsAt: null, windowSeconds: null });
  const view = (locale: Locale, h: Health, over: { hidden?: boolean; dirty?: boolean; onLogin?: () => void } = {}) =>
    renderToStaticMarkup(
      <HealthStepView locale={locale} h={h} hidden={over.hidden ?? false} dirty={over.dirty ?? false} busy={false} saving={false} onRun={noop} onSave={noop} onLogin={over.onLogin} />,
    );
  const done = (r: UsageReport | null): Health => ({ phase: 'done', report: r });

  const states = (locale: Locale) => [
    view(locale, { phase: 'checking' }),
    view(locale, { phase: 'checking' }, { dirty: true }),
    view(locale, { phase: 'failed', error: 'timeout' }),
    view(locale, done(null)),
    view(locale, done(report({ status: 'unconfigured' }))),
    view(locale, done(report({ meters: [meter(80)], plan: 'Max' })), { hidden: true }),
    view(locale, done(report({ status: 'needsLogin', message: 'msg del backend' })), { onLogin: noop }),
    view(locale, done(report({ status: 'warning', message: 'msg del backend' }))),
    view(locale, done(report({ status: 'error', message: 'msg del backend' }))),
  ];

  it('renders the Spanish literals copied verbatim from the current code', () => {
    const html = states('es').join('\n');
    expectAll(
      html,
      [
        'Comprobando la conexión…',
        'Consultando con lo guardado…',
        'Tienes cambios sin guardar: la comprobación usa lo guardado.',
        'Guardar y comprobar',
        'Comprobar ahora',
        'No se pudo comprobar ahora: timeout. Vuelve a intentarlo.',
        'Guarda los cambios para comprobar esta cuenta.',
        'Falta completar un paso',
        'Funciona',
        'Sesión 5 h al 80% · oculta en el widget',
        'Max · Sesión 5 h al 80%',
        'Sin sesión',
        'Iniciar sesión',
        'Atención',
        'No funciona',
        'msg del backend',
      ],
      'es',
    );
  });

  it('renders the English texts when the locale is en, with no Spanish left', () => {
    const html = states('en').join('\n');
    expectAll(
      html,
      [
        'Checking the connection…',
        'Checking with what is saved…',
        'You have unsaved changes: the check uses what is saved.',
        'Save and check',
        'Check now',
        'Could not check right now: timeout. Try again.',
        'Save the changes to check this account.',
        'A step is missing',
        'Works',
        'Sesión 5 h at 80% · hidden in the widget',
        'Max · Sesión 5 h at 80%',
        'Signed out',
        'Sign in',
        'Attention',
        'Not working',
        'msg del backend',
      ],
      'en',
    );
    expectNone(
      html,
      [
        'Comprobando',
        'Consultando',
        'Tienes cambios sin guardar',
        'Guardar y comprobar',
        'Comprobar ahora',
        'No se pudo comprobar',
        'Guarda los cambios',
        'Falta completar',
        'Funciona',
        'oculta en el widget',
        'Sin sesión',
        'Iniciar sesión',
        'Atención',
        'No funciona',
      ],
      'en',
    );
  });

  it('healthSummary keeps the Spanish literals in es and translates the fixed parts in en', () => {
    const withSpend = report({ spend: { amount: 12, currency: 'USD', periodLabel: 'Este mes', budget: null } });
    expect(healthSummary(report({ meters: [meter(80)] }))).toBe('Sesión 5 h al 80%');
    expect(healthSummary(report({ meters: [meter(80)], plan: 'Max' }), 'es')).toBe('Max · Sesión 5 h al 80%');
    expect(healthSummary(withSpend, 'es')).toContain('Este mes: ');
    expect(healthSummary(report({ meters: [meter(null)] }), 'es')).toBe('Datos recibidos');
    expect(healthSummary(report({ meters: [meter(80)], plan: 'Max' }), 'en')).toBe('Max · Sesión 5 h at 80%');
    expect(healthSummary(report({ meters: [meter(null)] }), 'en')).toBe('Data received');
  });

  const missing = (locale: Locale, provider: 'claude' | 'codex') => renderToStaticMarkup(<CliMissing provider={provider} locale={locale} />);

  it('CliMissing renders the Spanish literals verbatim and the English texts in en', () => {
    expectAll(
      missing('es', 'codex'),
      ['Falta Codex CLI en este equipo.', 'Quorb inicia sesión con su login oficial. Instálalo desde una terminal (necesita Node.js); Quorb lo detecta solo al terminar.', 'npm install -g @openai/codex', 'Copiar'],
      'es',
    );
    expectAll(missing('es', 'claude'), ['Falta Claude Code en este equipo.', 'Instálalo desde PowerShell; Quorb lo detecta solo al terminar.'], 'es');

    const en = missing('en', 'codex') + missing('en', 'claude');
    expectAll(
      missing('en', 'codex'),
      ['Codex CLI is missing on this computer.', 'Quorb signs in with its official login. Install it from a terminal (needs Node.js); Quorb detects it on its own when it finishes.', 'npm install -g @openai/codex', 'Copy'],
      'en',
    );
    expectAll(missing('en', 'claude'), ['Claude Code is missing on this computer.', 'Install it from PowerShell;'], 'en');
    expectNone(en, ['Falta', 'en este equipo', 'inicia sesión', 'Instálalo', 'una terminal', 'necesita', 'Copiar', 'solo al terminar'], 'en');
  });
});

// `aria-current` y `aria-expanded` deben seguir la tarjeta seleccionada y el panel
// abierto, no estar fijos (nota 3 de #204, T2c slice 2 C1b).
describe('Provider cards: aria-current and aria-expanded follow the selection (SSR)', () => {
  const count = (html: string, needle: string) => html.split(needle).length - 1;
  const cards = (html: string) => count(html, 'class="eg-module-card q-provider"');
  /** Fragmento que empieza en la tarjeta marcada como actual (sin pasar a la siguiente). */
  const current = (html: string) => {
    const start = html.indexOf('aria-current="true"');
    return html.slice(start, html.indexOf('</button>', start));
  };

  it('marks only the selected provider card as current and expanded while the drawer is open', () => {
    const html = card('es', 'claude', true);
    expect(count(html, 'aria-current="true"'), 'una sola tarjeta actual').toBe(1);
    expect(count(html, 'aria-expanded="true"')).toBe(1);
    expect(current(html)).toContain('Claude');
    expect(count(html, 'aria-current="false"')).toBe(cards(html) - 1);
    expect(count(html, 'aria-expanded="false"')).toBe(cards(html) - 1);
  });

  it('follows the selected tab', () => {
    const html = card('es', 'copilot', true);
    expect(count(html, 'aria-current="true"')).toBe(1);
    expect(current(html)).toContain('GitHub Copilot');
    expect(current(html)).not.toContain('Claude');
  });

  it('marks no card as current or expanded when the drawer is closed', () => {
    const html = card('es', 'claude', false);
    expect(count(html, 'aria-current="true"')).toBe(0);
    expect(count(html, 'aria-expanded="true"')).toBe(0);
    expect(count(html, 'aria-current="false"')).toBe(cards(html));
    expect(count(html, 'aria-expanded="false"')).toBe(cards(html));
  });
});
