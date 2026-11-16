// Tabla de slots del mock de react (#286).
//
// Los tests que montan el `Widget` completo (auto-hide.test.ts) referencian los
// estados/refs del mock por POSICIÓN, pero en runtime los hooks no tienen
// nombre: `vi.mock('react')` solo recibe `useRef(initial)` o
// `useState(initial)`. Este módulo es la ÚNICA fuente de verdad de esa
// correspondencia nombre → índice, en orden de ejecución del render:
//
//   useWidgetStartup consume states[0..2] y refs[0] antes que Widget
//   (`config`, `configFailed`, `configError` y `generation`), y después vienen
//   los propios de Widget en orden de declaración.
//
// Regla de mantenimiento: al añadir/reordenar un `useState`/`useRef` en
// `Widget.tsx` o en el hook, SOLO se toca este fichero — los índices se
// derivan de la posición en el array. Un test de coherencia (#286) falla si la
// tabla se desalinea con lo que el render realmente consume, y el mock lanza
// en el punto exacto si un render sobrepasa los contadores declarados.
//
// `initial` es el valor esperado del hook en el primer render; sirve de
// oráculo para detectar reordenamientos (no como mecanismo de lookup, que
// sigue siendo el índice). Los iniciales no deterministas (objetos creados por
// factoría, `Date.now()`, funciones, promesas…) llevan `SKIP`.

/** Marcador: el valor inicial no es determinista y no se verifica. */
export const SKIP = Symbol('test-slots.skip-initial');

export interface SlotSpec {
  name: string;
  initial: unknown;
}

/** Estados que `Widget` crea en un render, en orden de ejecución. */
export const WIDGET_STATES = [
  { name: 'config', initial: null },          // useWidgetStartup
  { name: 'configFailed', initial: false },   // useWidgetStartup
  { name: 'configError', initial: null },     // useWidgetStartup
  { name: 'reports', initial: [] },
  { name: 'loading', initial: false },
  { name: 'updatedAt', initial: null },
  { name: 'error', initial: null },
  { name: 'geo', initial: null },
  { name: 'stripSize', initial: null },
  { name: 'panel', initial: SKIP },           // NO_PANEL
  { name: 'anchorRel', initial: 0 },
  { name: 'dragging', initial: false },
  { name: 'pos', initial: { strip: { x: 0, y: 0 } } },
  { name: 'inside', initial: false },
  { name: 'collapsed', initial: false },
  { name: 'focused', initial: false },
  { name: 'peekFocused', initial: false },
  { name: 'placementRetry', initial: 0 },
  { name: 'placementFailed', initial: false },
  { name: 'placementReason', initial: null },
  { name: 'revealUntil', initial: 0 },
  { name: 'reorder', initial: null },
  { name: 'update', initial: { phase: 'idle' } },
] as const satisfies readonly SlotSpec[];

/** Refs que `Widget` crea en un render, en orden de ejecución. */
export const WIDGET_REFS = [
  { name: 'generation', initial: 0 },         // useWidgetStartup
  { name: 'stripRef', initial: null },
  { name: 'peekRef', initial: null },
  { name: 'widgetQueue', initial: SKIP },     // createLatestQueue()
  { name: 'widgetBounds', initial: null },
  { name: 'widgetBoundsReadBack', initial: false },
  { name: 'placementInFlight', initial: false },
  { name: 'orbsRef', initial: null },
  { name: 'detailStateRef', initial: null },
  { name: 'detailReadyRef', initial: false },
  { name: 'detailRevision', initial: SKIP },  // Date.now()
  // #264/S32 (merge de #275): el puntero del detalle ya no se lee por ref,
  // lo comunica el propio detalle por eventos. Tres refs nuevas del Widget:
  { name: 'hoverRef', initial: 'outside' },
  { name: 'hoverAtRef', initial: 0 },
  { name: 'nativeCrossingsRef', initial: SKIP },  // { widget: false, detail: false }
  { name: 'configRef', initial: null },
  { name: 'appliedConfigRef', initial: null },
  { name: 'reportsRef', initial: [] },
  { name: 'geoRef', initial: null },
  { name: 'inFlight', initial: false },
  { name: 'refreshAbort', initial: null },
  { name: 'refreshSeq', initial: 0 },
  { name: 'refreshEnv', initial: '' },
  { name: 'closeTimer', initial: undefined },
  { name: 'openTimer', initial: undefined },
  { name: 'presenceRef', initial: SKIP },     // createDetailPresence(...)
  { name: 'shown', initial: false },
  { name: 'hiddenByUser', initial: false },
  { name: 'drag', initial: null },
  { name: 'orbDrag', initial: null },
  { name: 'lastReorderAt', initial: 0 },
  { name: 'reorderHold', initial: SKIP },     // NO_HOLD (ReorderHold, #264/S23)
  { name: 'openPeakRef', initial: SKIP },     // () => {}
  { name: 'dragWork', initial: SKIP },        // Promise.resolve()
  { name: 'dragMounted', initial: true },
] as const satisfies readonly SlotSpec[];

/** Estados del probe de `useWidgetStartup` (use-widget-startup.test.ts). */
export const STARTUP_STATES = [
  { name: 'config', initial: null },
  { name: 'configFailed', initial: false },
  { name: 'configError', initial: null },
] as const satisfies readonly SlotSpec[];

/** Construye `nombre → índice` desde un array ordenado (única fuente). */
function indexByName<T extends readonly SlotSpec[]>(specs: T): Record<T[number]['name'], number> {
  return Object.fromEntries(specs.map((s, i) => [s.name, i])) as Record<T[number]['name'], number>;
}

/** `SLOT.shown`, `SLOT.geo`, `SLOT.stripRef`… → índice posicional en el mock. */
export const SLOT = {
  ...indexByName(WIDGET_STATES),
  ...indexByName(WIDGET_REFS),
};

/** Índices del probe del hook (separados: el hook no monta Widget). */
export const STARTUP_SLOT = indexByName(STARTUP_STATES);

export const WIDGET_STATE_COUNT = WIDGET_STATES.length;
export const WIDGET_REF_COUNT = WIDGET_REFS.length;
export const STARTUP_STATE_COUNT = STARTUP_STATES.length;