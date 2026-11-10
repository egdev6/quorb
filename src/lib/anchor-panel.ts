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
 * Coordinador de apertura retardada y cierre por Escape (#170).
 *
 * Desacopla la lógica de temporizadores y cierre del DOM para que el cableado
 * pueda probarse de forma determinista sin servidor X ni GUI:
 * - Si se programa una apertura y se pulsa `Escape` antes del retardo, la
 *   apertura pendiente se cancela y el panel permanece cerrado.
 * - Lo mismo aplica al recibir el evento `Escape` desde la ventana de detalle.
 */
export interface PanelCoordinator {
  /** El estado actual del panel. */
  getState(): PanelState;
  /** Solicita abrir el panel (hover o foco de teclado). */
  requestOpen(providerId: string, delayMs?: number): void;
  /** Clic en un orbe (ancla o desancla). */
  click(providerId: string): void;
  /** Escape (desde la tira o desde el panel de detalle): cancela aperturas y cierra. */
  escape(): void;
  /** Cancela cualquier temporizador pendiente. */
  cancelTimers(): void;
}

export const createPanelCoordinator = (
  onStateChange: (state: PanelState) => void,
  opts: {
    initialState?: PanelState;
    schedule?: (run: () => void, ms: number) => () => void;
  } = {},
): PanelCoordinator => {
  let state = opts.initialState ?? NO_PANEL;
  let cancelOpen: (() => void) | null = null;
  const schedule =
    opts.schedule ??
    ((run: () => void, ms: number) => {
      const id = setTimeout(run, ms);
      return () => clearTimeout(id);
    });

  const update = (next: PanelState) => {
    state = next;
    onStateChange(next);
  };

  const cancelTimers = () => {
    cancelOpen?.();
    cancelOpen = null;
  };

  return {
    getState: () => state,
    requestOpen(providerId: string, delayMs = 0) {
      if (state.anchored) return;
      cancelTimers();
      const apply = () => {
        cancelOpen = null;
        update(hoverPanel(state, providerId));
      };
      if (state.providerId || delayMs <= 0) {
        apply();
      } else {
        cancelOpen = schedule(apply, delayMs);
      }
    },
    click(providerId: string) {
      cancelTimers();
      update(clickPanel(state, providerId));
    },
    escape() {
      cancelTimers();
      update(closePanel());
    },
    cancelTimers,
  };
};

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
