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
    ]);
    expect(rows[0]).toMatchObject({ state: 'ok', note: 'ok-aot' });
    expect(rows[1]).toMatchObject({ state: 'limited', note: 'limitado' });
  });

  it('detecta cuando alguna superficie tiene límites declarados', () => {
    expect(hasLimitedSurfaces(surfaces)).toBe(true);
    expect(hasLimitedSurfaces({ ...surfaces, clickThrough: { state: 'ok', note: '' }, globalShortcuts: { state: 'ok', note: '' } })).toBe(
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
  });
});
