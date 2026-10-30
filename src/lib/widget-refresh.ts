import type { AppConfig } from './types';

/**
 * Campos de la config que, si cambian, obligan a volver a pedir datos a los
 * proveedores. Mover la tira o cambiar colores NO está aquí: eso no debe disparar
 * peticiones. Incluye todos los proveedores, también 9Router (periodo, presupuesto,
 * umbral de gasto, desglose de sub-proveedores y su `enabled`) y z.ai y OpenCode Go.
 */
export function dataKey(c: AppConfig | null): string {
  return c
    ? JSON.stringify([c.claude, c.codex, c.gemini, c.cursor, c.grok, c.copilot, c.openrouter, c.anthropicApi, c.openaiApi, c.nan, c.minimax, c.nineRouter, c.zai, c.opencodeGo])
    : '';
}

/** ¿El cambio de config obliga a refrescar los datos de los proveedores? */
export function needsRefresh(prev: AppConfig | null, next: AppConfig): boolean {
  return dataKey(prev) !== dataKey(next);
}
