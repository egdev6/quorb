// La ventana de un medidor: cuándo termina (el reinicio) y cuándo empezó. Un solo sitio
// para el cálculo, usado igual por los avisos de reinicio y por el ritmo de consumo.

import type { Meter } from './types';

const DAY_MS = 86_400_000;

/** Fin de la ventana: `resetsAt` es el reinicio. Sin él (o ilegible), no hay ventana. */
export function windowEnd(m: Meter): number | null {
  if (!m.resetsAt) return null;
  const end = Date.parse(m.resetsAt);
  return Number.isNaN(end) ? null : end;
}

/** Inicio de la ventana: el fin menos su duración. Sin ambos datos, no se puede saber. */
export function windowStart(m: Meter): number | null {
  const end = windowEnd(m);
  if (end == null || m.windowSeconds == null) return null;
  return end - m.windowSeconds * 1000;
}

/** Día UTC (índice) de un instante: las ventanas se comparan por día, nunca por instante. */
export const utcDay = (ms: number) => Math.floor(ms / DAY_MS);
