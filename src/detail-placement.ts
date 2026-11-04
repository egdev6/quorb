// Decisión sobre el informe nativo del panel de detalle (#215).
//
// El backend es la autoridad sobre la geometría nativa efectiva: responde con
// un informe espejo del de la tira (`detail_placement.rs` re-exporta los tipos
// de `widget_placement.rs`, así ambos ciclos comparten un solo contrato). Este
// módulo decide qué se cachea de ese informe y compone el reintento silencioso
// de una ventana todavía no legible; las primitivas de `widget-placement.ts` se
// reutilizan, nunca se duplican.

import type { PhysicalBounds } from './lib/detail-panel';
import { readPlacementWithRetries, type WidgetPlacementReport } from './lib/widget-placement';

/**
 * Informe de colocación nativa del detail: el backend viaja con la misma
 * estructura que el de la tira, así el frontend trata con un solo contrato.
 */
export type DetailPlacementReport = WidgetPlacementReport;

/**
 * Qué hace el frontend con un informe nativo:
 *
 * - `bounds` es la geometría que se cachea como aplicada. Sólo la cachea si el
 *   backend la leyó del compositor (`read_back`): la solicitud pedida **nunca**
 *   se cachea como confirmada (S3), así un re-pedido idéntico no se deduplica
 *   por una geometría que quizá nunca se aplicó.
 * - `retry` marca el informe blando de una ventana todavía no legible
 *   (`not_viewable`): tras `show()` se vuelve a pedir la colocación en silencio.
 */
export interface DetailPlacementDecision {
  bounds: PhysicalBounds | null;
  retry: boolean;
}

/**
 * Decide el cache y el reintento a partir del informe nativo.
 *
 * - `applied` leyó la geometría concedida y también `limited` informa tal cual
 *   el read-back (aunque el gestor haya concedido otra: `size_refused`/
 *   `position_refused`): en ambos casos el cache es exactamente la geometría
 *   efectiva, no la solicitud (D2).
 * - Un informe cancelado (`superseded`), una lectura fallida o el no-X11
 *   (`unverified` sin geometría y sin motivo de ventana oculta) no dejan nada
 *   en el cache: no hay geometría fiable y no hay reintento — el flujo queda
 *   tal como el de #215 antes del read-back (S1).
 */
export const decideDetailPlacement = (report: DetailPlacementReport): DetailPlacementDecision => {
  if (report.status === 'superseded') return { bounds: null, retry: false };
  if (report.reason === 'not_viewable') return { bounds: null, retry: true };
  return { bounds: report.read_back && report.bounds ? report.bounds : null, retry: false };
};

/**
 * Aplica la decisión de un informe a la caché del panel: la geometría confirmada
 * (read-back) es lo único que entra; devuelve el mismo veredicto de reintento.
 */
export const confirmDetailPlacement = (
  report: DetailPlacementReport,
  cache: (bounds: PhysicalBounds) => void,
): boolean => {
  const decision = decideDetailPlacement(report);
  if (decision.bounds) cache(decision.bounds);
  return decision.retry;
};

/** Operaciones nativas del reintento, con el presupuesto injectable para los tests. */
export interface DetailRetryIo {
  place: (bounds: PhysicalBounds) => Promise<DetailPlacementReport>;
  /** True mientras el job sigue vigente y el panel montado: aborta los reintentos. */
  isCurrent: () => boolean;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Vuelve a pedir la colocación en silencio después de `show()` cuando el
 * informe blando dijo que la ventana todavía no era legible (`not_viewable`).
 *
 * El backend no puede leer una ventana oculta: ese informe no es un fallo real,
 * es el compositor tardando en mapear. Con el mismo presupuesto acotado que la
 * tira (#221) se re-pide la misma colocación —abortándola si el detalle cerró o
 * cambió mientras tanto (isCurrent)— y se devuelve el último informe: si salió
 * agotado, el llamante cachea nada y la apertura nunca se bloqueó (S3).
 */
export const retryDetailPlacement = (
  requested: PhysicalBounds,
  io: DetailRetryIo,
): Promise<DetailPlacementReport | null> =>
  readPlacementWithRetries(
    async () => {
      if (!io.isCurrent()) return null;
      return io.place(requested);
    },
    {
      shouldAbort: () => !io.isCurrent(),
      ...(io.attempts === undefined ? {} : { attempts: io.attempts }),
      ...(io.delayMs === undefined ? {} : { delayMs: io.delayMs }),
      ...(io.sleep === undefined ? {} : { sleep: io.sleep }),
    },
  );
