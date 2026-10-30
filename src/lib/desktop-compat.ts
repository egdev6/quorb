// Bloque «Sesión de escritorio» de Ajustes (issue #107): presenta los límites
// por superficie que reporta el backend (`get_wm_info` → `wm_compat.rs`).
// El backend decide el estado; el frontend solo nombra y ordena. En Windows y
// macOS el bloque no se muestra: sus superficies no dependen del compositor.

import type { DesktopSurfaces } from './wm-detect';
import type { Locale } from './types';
import { t, type MessageKey } from '../i18n';

export interface DesktopCompatRow {
  /** Etiqueta visible de la superficie, en el idioma de Ajustes. */
  label: string;
  state: 'ok' | 'limited';
  note: string;
}

const SURFACE_LABELS: { key: keyof DesktopSurfaces; label: MessageKey }[] = [
  { key: 'alwaysOnTop', label: 'settings.shell.surfaces.alwaysOnTop' },
  { key: 'clickThrough', label: 'settings.shell.surfaces.clickThrough' },
  { key: 'trayIcon', label: 'settings.shell.surfaces.trayIcon' },
  { key: 'globalShortcuts', label: 'settings.shell.surfaces.globalShortcuts' },
  { key: 'autostart', label: 'settings.shell.surfaces.autostart' },
  { key: 'notifications', label: 'settings.shell.surfaces.notifications' },
  { key: 'transparency', label: 'settings.shell.surfaces.transparency' },
  // #180: order mirrors the Rust struct (`window_positioning` is the last surface).
  { key: 'windowPositioning', label: 'settings.shell.surfaces.windowPositioning' },
];

/** Filas del bloque «Sesión de escritorio», en orden fijo y sin filtrar. */
export function desktopCompatRows(surfaces: DesktopSurfaces, locale: Locale = 'es'): DesktopCompatRow[] {
  return SURFACE_LABELS.map(({ key, label }) => ({ label: t(locale, label), state: surfaces[key].state, note: surfaces[key].note }));
}

/** ¿Alguna superficie reporta límites en la sesión detectada? */
export function hasLimitedSurfaces(surfaces: DesktopSurfaces): boolean {
  return SURFACE_LABELS.some(({ key }) => surfaces[key].state === 'limited');
}

/**
 * ¿Toca mostrar el bloque? Solo donde el comportamiento depende del compositor.
 * Testeable: la UA se inyecta; en producción llega `navigator.userAgent`.
 */
export function showDesktopCompat(ua: string): boolean {
  return /Linux/.test(ua) && !/Android/.test(ua);
}
