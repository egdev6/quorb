// El estado del panel de detalle (#170).
//
// Un **solo** estado con dos datos: el provider cuyo panel está visible y si
// está anclado. Con un solo estado las reglas no pueden discrepar entre sí:
// el hover, el temporizador, el clic y la pérdida de foco compiten por el
// mismo valor en vez de llevar banderas paralelas.
//
// El anclaje es deliberado (un clic): con el panel anclado, el puntero no lo
// puede cambiar por debajo y el hover no lo cierra.

/** El provider cuyo panel está abierto y si ese panel está anclado. */
export interface PanelState {
  /** El provider visible; `null` si no hay panel. */
  providerId: string | null;
  /** True si el panel está anclado: el hover y el temporizador no lo cierran. */
  anchored: boolean;
}

/** El estado inicial: sin panel. */
export const NO_PANEL: PanelState = { providerId: null, anchored: false };

/**
 * El hover abre el panel transitorio.
 *
 * Con el panel anclado no hace nada: el anclado lo eligió un clic y el
 * puntero no lo cambia por debajo (para cambiar de provider hay que hacer
 * clic, que además mantiene el anclaje).
 */
export const hoverPanel = (state: PanelState, providerId: string): PanelState =>
  state.anchored ? state : { providerId, anchored: false };

/**
 * El clic ancla el panel.
 *
 * Sobre el orbe ya anclado, desancla y cierra. Sobre otro orbe, cambia de
 * provider **manteniendo** el anclaje. Sobre un panel transitorio, lo ancla.
 */
export const clickPanel = (state: PanelState, providerId: string): PanelState => {
  if (state.anchored && state.providerId === providerId) return NO_PANEL;
  return { providerId, anchored: true };
};

/** Cerrar el panel: el anclaje se va con él. */
export const closePanel = (): PanelState => NO_PANEL;

/** True mientras el panel esté anclado: el hover y el temporizador no lo cierran. */
export const panelHoldsOpen = (state: PanelState): boolean => state.anchored;

/**
 * La guarda tras reordenar, en milisegundos.
 *
 * El clic llega **después** de `pointerup`, donde el gesto ya se consumió, así
 * que el umbral de 6 px (`orbDrag.moved`) no llega al clic: lo que lo frena es
 * esta ventana, que empieza al soltar.
 */
export const REORDER_GUARD_MS = 400;

/**
 * True cuando el gesto sobre el orbe fue un arrastre de reordenación y no un
 * clic: reordenar no puede anclar el panel por accidente.
 */
export const isReorderGesture = (lastReorderAt: number, now: number): boolean =>
  now - lastReorderAt < REORDER_GUARD_MS;
