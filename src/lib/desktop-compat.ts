// Bloque «Sesión de escritorio» de Ajustes (issue #107): presenta los límites
// por superficie que reporta el backend (`get_wm_info` → `wm_compat.rs`).
// El backend decide el estado; el frontend solo nombra y ordena. En Windows y
// macOS el bloque no se muestra: sus superficies no dependen del compositor.

import type { DesktopSurfaces } from './wm-detect';

export interface DesktopCompatRow {
  /** Etiqueta visible de la superficie (en español, como el resto de Ajustes). */
  label: string;
  state: 'ok' | 'limited';
  note: string;
}

const SURFACE_LABELS: { key: keyof DesktopSurfaces; label: string }[] = [
  { key: 'alwaysOnTop', label: 'Siempre encima' },
  { key: 'clickThrough', label: 'Clic a través de los huecos' },
  { key: 'trayIcon', label: 'Icono de bandeja' },
  { key: 'globalShortcuts', label: 'Atajos globales' },
  { key: 'autostart', label: 'Arranque al iniciar sesión' },
  { key: 'notifications', label: 'Notificaciones' },
  { key: 'transparency', label: 'Transparencia' },
];

/** Filas del bloque «Sesión de escritorio», en orden fijo y sin filtrar. */
export function desktopCompatRows(surfaces: DesktopSurfaces): DesktopCompatRow[] {
  return SURFACE_LABELS.map(({ key, label }) => ({ label, state: surfaces[key].state, note: surfaces[key].note }));
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
