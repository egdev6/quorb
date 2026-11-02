// El seam de foco (#170).
//
// El anclaje se suelta cuando el foco sale de **las dos** ventanas propias:
// la tira y el detalle. El detalle es focusable (`src-tauri/src/lib.rs`), así
// que al hacer clic dentro del panel para copiar un dato el foco pasa a esa
// ventana: eso sigue siendo «dentro de nuestra interfaz» y no cierra nada.
//
// La decisión no se toma en el evento sino después: la pérdida de foco de la
// ventana antigua llega **antes** que la ganancia de la nueva (en X11 el
// gestor envía `FocusOut` a la vieja y `FocusIn` a la nueva; en macOS
// `windowDidResignKey` precede a `windowDidBecomeKey`; en Windows
// `WM_KILLFOCUS` precede a `WM_SETFOCUS`). Por eso hay una ventana de
// asentamiento: si en ese margen una de nuestras ventanas recupera el
// foco, el anclaje aguanta.

/** Las dos ventanas propias: la tira y el panel de detalle. */
export type OwnWindow = 'widget' | 'detail';

/**
 * El canal por el que el backend avisa del foco de nuestras ventanas.
 *
 * Es un evento de ventana nativo (`WindowEvent::Focused`), no del DOM: llega
 * igual en X11, Wayland, Windows y macOS, y no depende de que WebKit entregue
 * los eventos de ratón (el problema de #154).
 */
export const FOCUS_EVENT = 'window-focus';

/**
 * Margen de asentamiento antes de soltar el anclaje.
 *
 * La transferencia de foco entre nuestras dos ventanas ocurre en el mismo
 * lote de eventos, así que el margen sólo tiene que cubrir eso: es un
 * margen, no una espera de la interfaz.
 */
export const FOCUS_SETTLE_MS = 150;

export interface FocusTracker {
  /** Registra si una de nuestras ventanas tiene el foco. */
  setFocus(window: OwnWindow, focused: boolean): void;
  /** Cancela la comprobación pendiente (la ventana ya no está en pie). */
  cancel(): void;
}

/**
 * Crea el seam de foco.
 *
 * `onFocusLost` se llama una vez por episodio: cuando el foco se ha ido de
 * las dos ventanas propias y sigue fuera tras el margen. Si una ventana
 * propia recupera el foco, el episodio se cierra y el siguiente aviso
 * vuelve a estar disponible.
 */
export const createFocusTracker = (
  onFocusLost: () => void,
  opts: {
    settleMs?: number;
    schedule?: (run: () => void, ms: number) => () => void;
  } = {},
): FocusTracker => {
  const settleMs = opts.settleMs ?? FOCUS_SETTLE_MS;
  const schedule =
    opts.schedule ??
    ((run: () => void, ms: number) => {
      const id = setTimeout(run, ms);
      return () => clearTimeout(id);
    });
  let focused: Record<OwnWindow, boolean> = { widget: false, detail: false };
  let cancelPending: (() => void) | null = null;
  let reported = false;

  const anyFocused = () => focused.widget || focused.detail;
  const clearPending = () => {
    cancelPending?.();
    cancelPending = null;
  };

  return {
    setFocus(window, isFocused) {
      focused = { ...focused, [window]: isFocused };
      if (anyFocused()) {
        // El foco está en una de las nuestras: el anclaje no se suelta.
        clearPending();
        reported = false;
        return;
      }
      if (cancelPending) return;
      cancelPending = schedule(() => {
        cancelPending = null;
        if (anyFocused() || reported) return;
        reported = true;
        onFocusLost();
      }, settleMs);
    },
    cancel() {
      clearPending();
    },
  };
};
