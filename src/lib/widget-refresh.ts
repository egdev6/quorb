import type { AppConfig } from './types';

/**
 * Campos de la config que, si cambian, obligan a volver a pedir datos a los
 * proveedores. Mover la tira o cambiar colores NO está aquí: eso no debe disparar
 * peticiones. Incluye todos los proveedores, también 9Router (periodo, presupuesto,
 * umbral de gasto, desglose de sub-proveedores y su `enabled`) z.ai, OpenCode Go y Antigravity.
 *
 * El ENTORNO (host/WSL y la distro) también invalida los informes (revisión PR
 * #248): los datos de un entorno no valen para el otro, y sin esta clave el
 * widget seguiría mostrando la lectura del entorno anterior.
 *
 * El IDIOMA también (revisión PR #272): el backend traduce los mensajes
 * propios de los proveedores al hacer fetch y quedan guardados en el informe;
 * sin la locale en la clave, cambiar de idioma no los refrescaría.
 */
export function dataKey(c: AppConfig | null): string {
  return c
    ? JSON.stringify([c.locale, c.sessionEnv, c.wslDistro, c.claude, c.codex, c.gemini, c.cursor, c.grok, c.copilot, c.openrouter, c.anthropicApi, c.openaiApi, c.nan, c.minimax, c.nineRouter, c.zai, c.opencodeGo, c.antigravity])
    : '';
}

/** Identidad del entorno de sesión: host/WSL y su distro. */
export function envKey(c: AppConfig | null): string {
  return c ? `${c.sessionEnv}\u0000${c.wslDistro}` : '';
}

/** ¿El cambio de config obliga a refrescar los datos de los proveedores? */
export function needsRefresh(prev: AppConfig | null, next: AppConfig): boolean {
  return dataKey(prev) !== dataKey(next);
}
