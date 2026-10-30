// Corte visible de i18n (T2b-U2 R7/R8): la navegación de Ajustes y los títulos
// de la cabecera, renderizados en servidor (renderToStaticMarkup, sin DOM
// falso) con las etiquetas exactas en español y en inglés.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Locale } from '../lib/types';
import { SettingsHeadTitles, SettingsNav } from '../Settings';

const navProps = (locale: Locale, navCollapsed = false) => ({
  appName: 'Quorb',
  section: 'look' as const,
  locale,
  navCollapsed,
  onSelectSection: () => {},
  onToggleNav: () => {},
  pendingProviders: 0,
  shortcutErrors: [],
  shortcutWarnings: [],
});

describe('SettingsNav (SSR)', () => {
  it('renders the Spanish nav labels copied verbatim from the current literals', () => {
    const html = renderToStaticMarkup(<SettingsNav {...navProps('es')} />);
    for (const label of ['Proveedores', 'Apariencia', 'Alertas', 'Atajos', 'Actualizaciones', 'Ajustes']) {
      expect(html, `falta «${label}» en es`).toContain(label);
    }
    expect(html).not.toContain('Providers');
    expect(html).not.toContain('Appearance');
  });

  it('renders the English nav labels when the locale is en', () => {
    const html = renderToStaticMarkup(<SettingsNav {...navProps('en')} />);
    for (const label of ['Providers', 'Appearance', 'Alerts', 'Shortcuts', 'Updates', 'Settings']) {
      expect(html, `falta «${label}» en en`).toContain(label);
    }
    expect(html).not.toContain('Proveedores');
    expect(html).not.toContain('Apariencia');
  });

  it('uses the localized label as aria-label and title when the nav is collapsed', () => {
    const html = renderToStaticMarkup(<SettingsNav {...navProps('en', true)} />);
    expect(html).toContain('aria-label="Providers"');
    expect(html).toContain('title="Providers"');
  });

  // #181 (punto 1): los avisos de Wayland también cuentan en el badge de
  // «Atajos», sumados a los errores de registro.
  it('counts shortcut warnings together with errors in the shortcuts nav badge', () => {
    const html = renderToStaticMarkup(
      <SettingsNav {...navProps('es')} {...{ shortcutErrors: ['Ctrl+Alt+U: no se pudo registrar'], shortcutWarnings: ['Mostrar / ocultar (Ctrl+Alt+H): vía X11/XWayland'] }} />,
    );
    expect(html).toContain('eg-menu__count">2</span>');
    expect(html).not.toContain('eg-menu__count">1</span>');
  });

  it('shows a badge for warnings alone when there are no errors', () => {
    const html = renderToStaticMarkup(
      <SettingsNav {...navProps('es')} {...{ shortcutErrors: [], shortcutWarnings: ['a', 'b', 'c'] }} />,
    );
    expect(html).toContain('eg-menu__count">3</span>');
  });

  it('hides the shortcuts badge when there are neither errors nor warnings', () => {
    const html = renderToStaticMarkup(<SettingsNav {...navProps('es')} />);
    expect(html).not.toContain('eg-menu__count');
  });
});

describe('SettingsHeadTitles (SSR)', () => {
  it('renders the Spanish header (eyebrow, title, desc) for a section', () => {
    const html = renderToStaticMarkup(<SettingsHeadTitles locale="es" section="look" />);
    expect(html).toContain('Ajustes');
    expect(html).toContain('<h1>Apariencia</h1>');
    expect(html).toContain('Tamaño y color de los anillos, y dónde vive la tira.');
  });

  it('renders the English header for a section', () => {
    const html = renderToStaticMarkup(<SettingsHeadTitles locale="en" section="look" />);
    expect(html).toContain('<h1>Appearance</h1>');
    expect(html).toContain('Ring size and color, and where the strip sits.');
    expect(html).not.toContain('Apariencia');
  });

  it('renders every section header in both locales', () => {
    const titles = [
      ['providers', 'Suscripciones y APIs', 'Subscriptions &amp; APIs'],
      ['look', 'Apariencia', 'Appearance'],
      ['alerts', 'Alertas', 'Alerts'],
      ['shortcuts', 'Atajos', 'Shortcuts'],
      ['updates', 'Actualizaciones', 'Updates'],
    ] as const;
    for (const [section, esTitle, enTitle] of titles) {
      expect(renderToStaticMarkup(<SettingsHeadTitles locale="es" section={section} />), section).toContain(esTitle);
      expect(renderToStaticMarkup(<SettingsHeadTitles locale="en" section={section} />), section).toContain(enTitle);
    }
  });

  it('renders the section descriptions in both locales', () => {
    expect(renderToStaticMarkup(<SettingsHeadTitles locale="es" section="providers" />)).toContain(
      'Qué se consulta y cómo se conecta cada proveedor.',
    );
    expect(renderToStaticMarkup(<SettingsHeadTitles locale="en" section="providers" />)).toContain(
      'What gets checked and how each provider connects.',
    );
  });
});

// `aria-current` y `aria-expanded` siguen la sección seleccionada y el plegado
// del menú (nota 3 de #204, T2c slice 2 C1b).
describe('SettingsNav: aria-current and aria-expanded follow the state (SSR)', () => {
  const count = (html: string, needle: string) => html.split(needle).length - 1;
  const nav = (over: { section?: 'providers' | 'look'; navCollapsed?: boolean }) =>
    renderToStaticMarkup(<SettingsNav {...navProps('es', over.navCollapsed ?? false)} section={over.section ?? 'look'} />);

  it('marks only the selected section as the current page', () => {
    const look = nav({ section: 'look' });
    expect(count(look, 'aria-current="page"')).toBe(1);
    expect(look.slice(look.indexOf('aria-current="page"'))).toMatch(/^[^<]*>[\s\S]*?Apariencia/);
    expect(look.slice(0, look.indexOf('aria-current="page"'))).not.toContain('Apariencia');
    const providers = nav({ section: 'providers' });
    expect(count(providers, 'aria-current="page"')).toBe(1);
    expect(providers.slice(providers.indexOf('aria-current="page"'))).toMatch(/^[^<]*>[\s\S]*?Proveedores/);
    expect(providers.slice(0, providers.indexOf('aria-current="page"'))).not.toContain('Alertas');
  });

  it('sets aria-expanded on the toggle from the collapsed state', () => {
    const open = nav({ navCollapsed: false });
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain('aria-expanded="false"');
    const collapsed = nav({ navCollapsed: true });
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).not.toContain('aria-expanded="true"');
  });
});
