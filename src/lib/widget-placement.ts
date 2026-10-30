// Colocación nativa de la tira (#179).
//
// El backend es la autoridad sobre la geometría nativa efectiva: responde con
// lo que quedó en pantalla, nunca con la solicitud encolada. Este módulo
// decide qué se cachea con esa respuesta, si hay que ofrecer el reintento y
// qué motivo ve el usuario.

import { samePhysical, type PhysicalBounds } from './detail-panel';
import type { MessageKey } from '../i18n';

/** Borde del área de trabajo al que la tira está anclada. */
export type WidgetAnchor = 'top' | 'bottom' | 'left' | 'right';

/**
 * Lo que se pide al backend: el rectángulo, el borde anclado y el factor con el
 * que se calculó (en DPI mixto, el de la ventana puede ser otro).
 */
export interface WidgetPlacementRequest extends PhysicalBounds {
  anchor: WidgetAnchor;
  /** El factor de escala del monitor con el que se calculó el rectángulo. */
  scale: number;
}

/**
 * Códigos de motivo del backend (ASCII): son machine-readable y el widget los
 * traduce con el catálogo (`reasonKey`).
 */
export type WidgetPlacementReason =
  | 'size_refused'
  | 'position_refused'
  | 'not_viewable'
  | 'read_failed'
  | 'superseded';

/**
 * Informe de colocación nativa.
 *
 * - `applied`: la geometría efectiva se leyó del compositor y coincide con la
 *   pedida.
 * - `unverified`: la solicitud se aplicó pero no se pudo leer (Wayland nativo,
 *   Windows, macOS) o la lectura falló.
 * - `limited`: el gestor no concedió la geometría pedida.
 * - `superseded`: la colocación se canceló y su geometría quedó a medias: no
 *   es un origen fiable.
 */
export interface WidgetPlacementReport {
  status: 'applied' | 'unverified' | 'limited' | 'superseded';
  /** La geometría efectiva leída; `null` si no se pudo leer o se canceló. */
  bounds: PhysicalBounds | null;
  /** El código del motivo, si lo hay. */
  reason?: WidgetPlacementReason | null;
  /**
   * True si la geometría vino del read-back del compositor (X11). Sólo esa
   * geometría admite la tolerancia del redondeo: la que se pidió (Windows,
   * macOS, Wayland nativo) se compara exacta.
   */
  read_back?: boolean;
}

/**
 * Clave de catálogo con la etiqueta de cada código de motivo. El módulo no
 * lleva texto de interfaz: la traducción la hace el widget con `t(locale, key)`.
 */
const REASON_KEYS: Record<WidgetPlacementReason, MessageKey> = {
  size_refused: 'widget.reasonSizeRefused',
  position_refused: 'widget.reasonPositionRefused',
  not_viewable: 'widget.reasonNotViewable',
  read_failed: 'widget.reasonReadFailed',
  superseded: 'widget.reasonSuperseded',
};

/** La clave de catálogo del motivo; `null` si no hay motivo. */
export const reasonKey = (reason?: WidgetPlacementReason | null): MessageKey | null =>
  reason ? REASON_KEYS[reason] ?? null : null;

/**
 * Margen físico con el que se comparan dos geometrías: el mismo que usa el
 * backend. Con 1 px de margen un cambio real (2 px o más) sigue detectándose,
 * así que no hay oscilación.
 */
export const PLACEMENT_TOLERANCE = 1;

/** True cuando dos geometrías son la misma dentro de la tolerancia. */
export const samePhysicalWithin = (
  a: PhysicalBounds | null,
  b: PhysicalBounds,
  tolerance = PLACEMENT_TOLERANCE,
): boolean =>
  !!a &&
  Math.abs(a.x - b.x) <= tolerance &&
  Math.abs(a.y - b.y) <= tolerance &&
  Math.abs(a.w - b.w) <= tolerance &&
  Math.abs(a.h - b.h) <= tolerance;

/**
 * Compara la geometría cacheada con la pedida.
 *
 * La tolerancia de ±1 px es del read-back de X11 (el gestor redondea el
 * tamaño lógico a píxeles de dispositivo), así que **sólo** se aplica a la
 * geometría que vino del compositor. En el resto de plataformas (y en
 * cualquier ruta sin read-back) la comparación es exacta: un cambio de 1 px
 * sí es un cambio y se aplica.
 */
export const samePlacement = (
  cached: PhysicalBounds | null,
  requested: PhysicalBounds,
  readBack: boolean,
): boolean =>
  cached === null
    ? false
    : readBack
      ? samePhysicalWithin(cached, requested)
      : samePhysical(cached, requested);

/** Sólo la geometría física: la petición también lleva el ancla y el factor. */
const physicalOnly = (bounds: PhysicalBounds): PhysicalBounds => ({
  x: bounds.x,
  y: bounds.y,
  w: bounds.w,
  h: bounds.h,
});

/** Qué hace la tira con el informe de colocación. */
export interface PlacementOutcome {
  /** La geometría que queda cacheada como origen del arrastre; null = no cachear. */
  bounds: PhysicalBounds | null;
  /** True cuando el gestor no concedió la geometría: hay que ofrecer reintento. */
  failed: boolean;
  /** El código del motivo (machine-readable), no su texto: lo traduce el widget. */
  reason: WidgetPlacementReason | null;
  /** True si la geometría cacheada vino del read-back del compositor. */
  readBack: boolean;
}

/**
 * Traduce el informe nativo a la decisión del widget.
 *
 * La geometría cacheada es siempre la que el backend informó: la solicitud
 * nunca se cachea como verificada. Sin informe se conserva la geometría
 * pedida (sin darla por verificada); una colocación cancelada, una lectura
 * fallida o una ventana que no llegó a ser visible no cachean nada: no hay
 * geometría fiable.
 */
export const placementOutcome = (
  report: WidgetPlacementReport | null | undefined,
  requested: PhysicalBounds,
): PlacementOutcome => {
  if (!report) return { bounds: physicalOnly(requested), failed: false, reason: null, readBack: false };
  if (report.status === 'superseded') return { bounds: null, failed: false, reason: null, readBack: false };
  const reason = report.reason ?? null;
  // Sin lectura fiable no hay geometría que cachear: ni la solicitud.
  if (report.reason === 'read_failed' || report.reason === 'not_viewable') {
    return { bounds: null, failed: true, reason, readBack: false };
  }
  return {
    bounds: report.bounds ?? physicalOnly(requested),
    failed: report.status === 'limited',
    reason,
    readBack: report.read_back === true,
  };
};
