// #181 (punto 1): corte renderizable del panel «Atajos» con errores y avisos.
// Los avisos de Wayland se renderizan como `eg-notice--warning` con
// `role="status"` (no un `alert` rojo): son degradación informada, no un fallo
// de registro. Renderizado en servidor (renderToStaticMarkup, sin DOM falso),
// igual que settings-nav.test.tsx: la ventana completa de Ajustes necesita la
// API de Tauri (invoke/window) y no se monta en pruebas.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShortcutNotices } from '../Settings';

describe('ShortcutNotices (SSR)', () => {
  it('renders registration errors as danger alerts, verbatim', () => {
    const html = renderToStaticMarkup(
      <ShortcutNotices errors={['Mostrar / ocultar (Ctrl+Alt+U): no se pudo registrar, ¿lo usa otra app?']} warnings={[]} />,
    );
    expect(html).toContain('eg-notice--danger');
    expect(html).toContain('role="alert"');
    expect(html).toContain('no se pudo registrar');
    expect(html).not.toContain('eg-notice--warning');
  });

  it('renders Wayland warnings as neutral warning notices, not danger alerts', () => {
    const html = renderToStaticMarkup(
      <ShortcutNotices
        errors={[]}
        warnings={['Mostrar / ocultar (Ctrl+Alt+U): en Wayland el registro se hace vía X11/XWayland y puede no tener efecto global; el atajo puede no responder.']}
      />,
    );
    expect(html).toContain('eg-notice--warning');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('eg-notice--danger');
    expect(html).not.toContain('role="alert"');
    // El texto del backend se muestra tal cual: la degradación queda informada.
    expect(html).toContain('puede no tener efecto global');
    expect(html).toContain('puede no responder');
  });

  it('renders each warning separately and renders nothing when both lists are empty', () => {
    const html = renderToStaticMarkup(
      <ShortcutNotices errors={[]} warnings={['uno', 'dos']} />,
    );
    expect(html.match(/eg-notice--warning/g)).toHaveLength(2);
    expect(html).toContain('uno');
    expect(html).toContain('dos');
    const empty = renderToStaticMarkup(<ShortcutNotices errors={[]} warnings={[]} />);
    expect(empty).toBe('');
  });

  it('keeps errors and warnings distinguishable side by side', () => {
    const html = renderToStaticMarkup(
      <ShortcutNotices errors={['error']} warnings={['aviso']} />,
    );
    const danger = html.indexOf('eg-notice--danger');
    const warning = html.indexOf('eg-notice--warning');
    expect(danger).toBeGreaterThanOrEqual(0);
    expect(warning).toBeGreaterThan(danger);
  });
});
