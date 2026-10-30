import { describe, expect, it } from 'vitest';
import { desktopCompatRows, hasLimitedSurfaces, showDesktopCompat } from './desktop-compat';
import type { DesktopSurfaces } from './wm-detect';

const surfaces: DesktopSurfaces = {
  alwaysOnTop: { state: 'ok', note: 'ok-aot' },
  clickThrough: { state: 'limited', note: 'limitado' },
  trayIcon: { state: 'ok', note: 'ok-tray' },
  globalShortcuts: { state: 'limited', note: 'limitado' },
  autostart: { state: 'ok', note: 'ok-autostart' },
  notifications: { state: 'ok', note: 'ok-notif' },
  transparency: { state: 'ok', note: 'ok-transp' },
  // New surface #180 (WU4): decided by the effective GDK backend.
  windowPositioning: { state: 'limited', note: 'no disponible en este compositor' },
};

describe('desktop-compat', () => {
  it('las filas siguen el orden fijo de superficies con su nota del backend', () => {
    const rows = desktopCompatRows(surfaces);
    expect(rows.map((r) => r.label)).toEqual([
      'Siempre encima',
      'Clic a través de los huecos',
      'Icono de bandeja',
      'Atajos globales',
      'Arranque al iniciar sesión',
      'Notificaciones',
      'Transparencia',
      'Posicionamiento de la ventana',
    ]);
    expect(rows[0]).toMatchObject({ state: 'ok', note: 'ok-aot' });
    expect(rows[1]).toMatchObject({ state: 'limited', note: 'limitado' });
  });

  it('the windowPositioning row (#180) goes last and passes the backend note through verbatim', () => {
    const rows = desktopCompatRows(surfaces);
    expect(rows).toHaveLength(8);
    const row = rows[rows.length - 1];
    expect(row).toMatchObject({
      label: 'Posicionamiento de la ventana',
      state: 'limited',
      note: 'no disponible en este compositor',
    });
    const en = desktopCompatRows(surfaces, 'en');
    expect(en[en.length - 1]).toMatchObject({ label: 'Window positioning', state: 'limited' });
  });

  it('names the surfaces in English when the locale is en, keeping the backend note (T2c-S2 PR-B)', () => {
    const rows = desktopCompatRows(surfaces, 'en');
    expect(rows.map((r) => r.label)).toEqual([
      'Always on top',
      'Click-through gaps',
      'Tray icon',
      'Global shortcuts',
      'Start at login',
      'Notifications',
      'Transparency',
      'Window positioning',
    ]);
    // La nota la redacta el backend: es dato y se conserva tal cual.
    expect(rows[1]).toMatchObject({ state: 'limited', note: 'limitado' });
  });

  it('detecta cuando alguna superficie tiene límites declarados', () => {
    expect(hasLimitedSurfaces(surfaces)).toBe(true);
    expect(
      hasLimitedSurfaces({
        ...surfaces,
        clickThrough: { state: 'ok', note: '' },
        globalShortcuts: { state: 'ok', note: '' },
        windowPositioning: { state: 'ok', note: '' },
      })
    ).toBe(
      false
    );
  });

  it('el bloque solo se muestra donde el comportamiento depende del compositor', () => {
    // UA del webview de Quorb en Linux.
    expect(showDesktopCompat('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15')) .toBe(true);
    // Windows y macOS no la muestran: meta sin acciones allí.
    expect(showDesktopCompat('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/605.1.15')).toBe(false);
    expect(showDesktopCompat('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe(false);
    // Un Android (UA Linux móvil) tampoco.
    expect(showDesktopCompat('Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36')).toBe(false);
    // Sin UA (entornos headless/tests): tampoco se muestra.
    expect(showDesktopCompat('')).toBe(false);
  });
});
