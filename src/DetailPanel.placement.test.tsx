// El efecto de colocación del panel de detalle, ejercitado de verdad (#250/S17).
//
// React simulado como en `src/lib/auto-hide.test.ts`: se capturan los efectos
// reales del componente y se ejecutan a mano, sin DOM ni runtime de Tauri. Lo
// que se afirma es lo que el efecto hace —no una copia de él—: con un
// `read_failed` (la llamada nativa no se pudo confirmar) el panel no queda
// marcado como colocado, `showDetail` no se llama y la colocación se vuelve a
// pedir dentro del presupuesto; con una colocación confirmada el panel se
// muestra como siempre.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DetailPanel } from './DetailPanel';
import type { DetailPlacementReport } from './detail-placement';
import type { DetailState, PhysicalBounds } from './lib/detail-panel';

const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  stateIndex: 0,
  stateWrite: vi.fn(),
  refs: [] as { current: unknown }[],
  refIndex: 0,
  effects: [] as { run: () => void | (() => void) }[],
  layoutEffects: [] as { run: () => void | (() => void) }[],
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal() as typeof import('react');
  return {
    ...react,
    useState: ((initial?: unknown) => {
      const index = harness.stateIndex++;
      const value = index in harness.states ? harness.states[index]
        : typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [value, vi.fn((next: unknown) => {
        harness.stateWrite(index, next);
        const previous = index in harness.states ? harness.states[index] : value;
        harness.states[index] = typeof next === 'function' ? (next as (p: unknown) => unknown)(previous) : next;
      })] as unknown as ReturnType<typeof react.useState>;
    }) as unknown as typeof react.useState,
    useRef: ((initial: unknown) => {
      const index = harness.refIndex++;
      return harness.refs[index] ??= { current: initial };
    }) as unknown as typeof react.useRef,
    useEffect: ((run: () => void | (() => void)) => { harness.effects.push({ run }); }) as unknown as typeof react.useEffect,
    useLayoutEffect: ((run: () => void | (() => void)) => { harness.layoutEffects.push({ run }); }) as unknown as typeof react.useLayoutEffect,
  };
});

const native = vi.hoisted(() => ({
  setDetailBounds: vi.fn(),
  setSurfaceClip: vi.fn(),
  showDetail: vi.fn(),
  hide: vi.fn(),
}));

vi.mock('./lib/api', () => ({ api: {
  setDetailBounds: native.setDetailBounds,
  setSurfaceClip: native.setSurfaceClip,
  showDetail: native.showDetail,
} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ hide: native.hide }) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emitTo: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock('./i18n/use-locale', () => ({ useLocale: () => 'es' }));
vi.mock('./lib/useTextScale', () => ({ useTextScale: () => 1 }));

const granted: PhysicalBounds = { x: 815, y: 88, w: 330, h: 400 };

/** La llamada nativa no se pudo confirmar: la geometría no se aplicó. */
const readFailed = (): DetailPlacementReport => ({
  status: 'unverified', bounds: null, reason: 'read_failed', read_back: false,
});

/** La ventana todavía no era legible: informe blando, la geometría sí se pidió. */
const notViewable = (): DetailPlacementReport => ({
  status: 'unverified', bounds: null, reason: 'not_viewable', read_back: false,
});

/** Colocación confirmada: el compositor informó la geometría efectiva. */
const applied = (): DetailPlacementReport => ({
  status: 'applied', bounds: granted, read_back: true,
});

const detailState: DetailState = {
  revision: 1,
  report: { id: 'a', name: 'A' } as unknown as DetailState['report'],
  area: { x: 0, y: 0, w: 1920, h: 1080 },
  strip: { x: 760, y: 0, w: 400, h: 80 },
  edge: 'top',
  anchor: 980,
  width: 330,
  maxHeight: 900,
  scaleFactor: 1,
  orbSize: 56,
  opacity: 1,
  colors: ['#ffffff', '#888888', '#444444'],
  updatedAt: null,
  refreshMinutes: 30,
  error: null,
  usageUrl: undefined,
};

/** El elemento que el efecto de layout mide, recorta y coloca. */
const panelElement = {
  dataset: {} as Record<string, string>,
  style: { transform: 'scale(1)' },
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 330, height: 400, top: 0, left: 0, right: 330, bottom: 400 }),
};

/** Slots del componente: estado 1 = `positioned`, ref 3 = `lastAppliedRef`. */
const positioned = () => harness.states[1] === true;
const cached = () => harness.refs[3].current as PhysicalBounds | null;

/** Espera a que la cola de colocación termine (la cola encadena promesas). */
const flush = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};

/**
 * Monta el panel con estado y ejecuta su efecto de placement real con la
 * secuencia de informes nativa indicada.
 */
const runPlacement = async (reports: DetailPlacementReport[]) => {
  harness.states = [];
  harness.stateIndex = 0;
  harness.refs = [];
  harness.refIndex = 0;
  harness.effects = [];
  harness.layoutEffects = [];
  harness.states[0] = detailState; // `data`: hay algo que colocar.
  let index = 0;
  native.setDetailBounds.mockImplementation(async () => reports[Math.min(index++, reports.length - 1)]);
  native.setSurfaceClip.mockResolvedValue(undefined);
  native.showDetail.mockResolvedValue(true);
  // El componente registra sus efectos al llamarse.
  DetailPanel();
  harness.refs[0].current = panelElement; // `panelRef`
  expect(harness.layoutEffects).toHaveLength(1);
  const cleanup = harness.layoutEffects[0].run();
  await flush();
  return cleanup;
};

describe('the detail placement effect (#250/S17)', () => {
  beforeEach(() => {
    // El lazo de reintento usa `window.setTimeout`: sin esperas reales.
    vi.stubGlobal('window', {
      setTimeout: (fn: () => void) => { fn(); return 0; },
      clearTimeout: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      devicePixelRatio: 1,
    });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal('getComputedStyle', () => ({
      borderTopLeftRadius: '14px', borderTopRightRadius: '14px',
      borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px',
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('never places nor shows the panel when the native placement failed', async () => {
    const cleanup = await runPlacement([readFailed()]);
    // La colocación se vuelve a pedir: la inicial más el presupuesto acotado
    // de reintentos (5 lecturas).
    expect(native.setDetailBounds).toHaveBeenCalledTimes(6);
    // El panel no se muestra con la geometría anterior ni con la de fábrica.
    expect(native.showDetail).not.toHaveBeenCalled();
    expect(native.setSurfaceClip).not.toHaveBeenCalled();
    // El panel no queda marcado como colocado...
    expect(positioned()).toBe(false);
    // ...y nada queda cacheado como confirmado.
    expect(cached()).toBeNull();
    if (typeof cleanup === 'function') cleanup();
  });

  it('shows the panel as before when the placement is confirmed', async () => {
    const cleanup = await runPlacement([applied()]);
    expect(native.setDetailBounds).toHaveBeenCalledTimes(1);
    expect(native.showDetail).toHaveBeenCalledTimes(1);
    expect(positioned()).toBe(true);
    // Sólo la geometría confirmada (read-back) queda cacheada.
    expect(cached()).toEqual(granted);
    if (typeof cleanup === 'function') cleanup();
  });

  it('shows the panel once the retry confirms the placement', async () => {
    const cleanup = await runPlacement([readFailed(), applied()]);
    expect(native.setDetailBounds).toHaveBeenCalledTimes(2);
    expect(native.showDetail).toHaveBeenCalledTimes(1);
    expect(positioned()).toBe(true);
    expect(cached()).toEqual(granted);
    if (typeof cleanup === 'function') cleanup();
  });

  it('shows the panel and asks again after showing when the window was not viewable yet', async () => {
    // Preservado: `not_viewable` es blando (la geometría se pidió, sólo no se
    // pudo leer), así que el panel se muestra como antes y la colocación se
    // vuelve a pedir después de mostrarlo, dentro del presupuesto.
    const cleanup = await runPlacement([notViewable()]);
    expect(native.showDetail).toHaveBeenCalledTimes(1);
    expect(positioned()).toBe(true);
    // La inicial más el presupuesto de reintentos posterior al `show`.
    expect(native.setDetailBounds).toHaveBeenCalledTimes(6);
    // Nada queda cacheado como confirmado: el read-back nunca lo confirmó.
    expect(cached()).toBeNull();
    if (typeof cleanup === 'function') cleanup();
  });
});
