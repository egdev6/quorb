// Wrapper thin sobre el command Tauri `get_wm_info` (src-tauri/src/wm_compat.rs).
//
// F3 (#107, issue ODD de escritorio y widget nativos): Ajustes muestra un
// bloque «Compatibilidad» con la sesión de escritorio detectada y la
// recomendación del compositor (Hyprland, GNOME Wayland, KDE, fallback).
// El backend decide la recomendación; el frontend solo la presenta.

import { invoke } from '@tauri-apps/api/core';

/** Estado de una superficie de escritorio según la sesión detectada. */
export interface SurfaceStatus {
  state: 'ok' | 'limited';
  note: string;
}

export interface DesktopSurfaces {
  alwaysOnTop: SurfaceStatus;
  clickThrough: SurfaceStatus;
  trayIcon: SurfaceStatus;
  globalShortcuts: SurfaceStatus;
  autostart: SurfaceStatus;
  notifications: SurfaceStatus;
  transparency: SurfaceStatus;
}

export interface WindowManagerInfo {
  waylandDisplay: string | null;
  xdgSessionType: string | null;
  desktopSession: string | null;
  xdgCurrentDesktop: string | null;
  isWayland: boolean;
  isHyprland: boolean;
  recommendation: string;
  surfaces: DesktopSurfaces;
}

/** Llama al command Rust `get_wm_info` y devuelve la info del compositor. */
export async function detectWindowManager(): Promise<WindowManagerInfo> {
  return invoke<WindowManagerInfo>('get_wm_info');
}
