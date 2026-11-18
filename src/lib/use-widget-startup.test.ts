// Cableado del arranque del widget respecto a la configuración (#271).
//
// Revisión PR #271 (precisión 3): además del SSR de StripFallback/StripTools,
// esto prueba el temporizador de la red de seguridad, los estados de config
// pendiente/fallo definitivo y el `config-changed`, capturando los efectos del
// hook con el mismo patrón de `auto-hide.test.ts` (mock de react indexado) y
// `vi.useFakeTimers`.
//
// Snapshot perezoso: el render SSR no re-renderiza, así que el estado se lee
// de los slots del mock (los setters los actualizan) en lugar de re-renderizar.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWidgetStartup, STARTUP_SHOW_DELAY_MS } from './use-widget-startup';
import { SKIP, STARTUP_SLOT, STARTUP_STATES, STARTUP_STATE_COUNT } from './test-slots';

const state = vi.hoisted(() => ({
  states: [] as unknown[], stateIndex: 0,
  // Iniciales que el hook pasa a cada useState, en orden de render (#286).
  stateInitials: [] as unknown[],
  expectedStateCount: null as number | null,
  effects: [] as { run: () => void | (() => void); deps?: readonly unknown[] }[],
  getConfig: vi.fn(),
  listeners: new Map<string, ((event?: { payload?: unknown }) => void)[]>(),
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal() as typeof import('react');
  return {
    ...react,
    useState: ((initial?: unknown) => {
      const index = state.stateIndex++;
      state.stateInitials.push(initial);
      // Disparidad temprana con la tabla de slots (#286): el render del probe
      // no debe crear más useState de los declarados para el hook.
      const expected = state.expectedStateCount;
      if (expected != null && index >= expected) {
        throw new Error(`useWidgetStartup crea más useState (${index + 1}) de los que declara STARTUP_STATES (#286). Actualiza src/lib/test-slots.ts.`);
      }
      const value = index in state.states ? state.states[index]
        : typeof initial === 'function' ? initial() : initial;
      // El valor inicial vive en el slot: el test lo lee con `state.states[i]`
      // y los setters lo actualizan (el SSR no re-renderiza).
      state.states[index] = value;
      return [value, vi.fn((next: unknown) => {
        const previous = index in state.states ? state.states[index] : value;
        state.states[index] = typeof next === 'function' ? next(previous) : next;
      })];
    }) as typeof react.useState,
    useEffect: ((run, deps) => { state.effects.push({ run, deps }); }) as typeof react.useEffect,
  };
});
vi.mock('./api', () => ({ api: { getConfig: state.getConfig } }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event?: { payload?: unknown }) => void) => {
    const list = state.listeners.get(name) ?? [];
    list.push(handler);
    state.listeners.set(name, list);
    return () => {};
  }),
}));

// Recuento esperado de la tabla de slots del hook (#286): inyectado aquí
// (el factory de `vi.mock` no puede importar `test-slots` por hoisting).
state.expectedStateCount = STARTUP_STATE_COUNT;

/** Promise controlable para `getConfig` (pendiente hasta que el test decida). */
function deferred() {
  let resolve!: (c: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Renderiza un probe del hook y captura sus efectos (no los ejecuta aún). */
function probe(options: Parameters<typeof useWidgetStartup>[0] = {}) {
  state.stateIndex = 0;
  state.effects = [];
  let capturedApply: ((c: unknown) => void) | undefined;
  function Probe() {
    const s = useWidgetStartup(options);
    capturedApply = s.applyConfig as (c: unknown) => void;
    return createElement('pre', null, 'probe');
  }
  renderToStaticMarkup(createElement(Probe));
  // Slots del hook por nombre (#286): la tabla vive en `test-slots.ts`.
  const read = (): { config: unknown; configFailed: boolean; configError: string | null } => ({
    config: state.states[STARTUP_SLOT.config] ?? null,
    configFailed: state.states[STARTUP_SLOT.configFailed] as boolean,
    configError: (state.states[STARTUP_SLOT.configError] ?? null) as string | null,
  });
  const load = state.effects.find((e) => e.run.toString().includes('getConfig'))!;
  const timer = state.effects.find((e) => e.run.toString().includes('setTimeout'))!;
  return { read, load, timer, applyConfig: (c: unknown) => capturedApply?.(c) };
}

const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

/** `window` en el entorno node: el hook usa `window.setTimeout` (red de
 *  seguridad); con fake timers, `globalThis.setTimeout` ya es el fake. */
function useFakeWindowTimers() {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    setTimeout: (fn: (...args: unknown[]) => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h: unknown) => globalThis.clearTimeout(h as number),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  state.states = [];
  state.listeners.clear();
  state.getConfig.mockReset();
});

describe('useWidgetStartup wiring (#271)', () => {
  it('stays pending past the safety-net delay: show() (onReadyToShow) fires and no config is set', async () => {
    useFakeWindowTimers();
    const d = deferred();
    state.getConfig.mockReturnValue(d.promise);
    const onReadyToShow = vi.fn();
    const p = probe({ onReadyToShow });

    p.load.run();
    p.timer.run();
    // Config pendiente: avanzamos más del retraso de la red de seguridad.
    await vi.advanceTimersByTimeAsync(STARTUP_SHOW_DELAY_MS + 100);
    await flush();
    expect(onReadyToShow).toHaveBeenCalledTimes(1);
    // Sigue pendiente: `config` null, `configFailed` false.
    expect(p.read()).toEqual({ config: null, configFailed: false, configError: null });

    // Resolver después la config en inglés → lista.
    d.resolve({ locale: 'en' });
    await flush();
    expect(p.read().config).toEqual({ locale: 'en' });
    expect(p.read().configFailed).toBe(false);
  });

  it('marks configFailed when getConfig exhausts its retries (definitive failure)', async () => {
    useFakeWindowTimers();
    state.getConfig.mockRejectedValue(new Error('sin backend'));
    const p = probe();

    p.load.run();
    // Cinco reintentos con backoff: avanzamos suficiente para agotarlos.
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(p.read().configFailed).toBe(true);
    expect(p.read().configError).toContain('sin backend');
  });

  it('a config-changed failure does NOT mark configFailed (only the startup retry does)', async () => {
    useFakeWindowTimers();
    const d = deferred();
    state.getConfig.mockReturnValueOnce(d.promise); // arranque: primera llamada pendiente
    state.getConfig.mockRejectedValue(new Error('config-changed leyó mal')); // el resto
    const p = probe();

    p.load.run();
    // El listener de config-changed falla mientras el arranque sigue pendiente.
    const changed = state.listeners.get('config-changed')![0];
    await changed();
    await flush();
    // Sigue pendiente: el fallo de config-changed no activa el fallo definitivo.
    expect(p.read().configFailed).toBe(false);
    expect(p.read().config).toBeNull();

    // Al agotarse el arranque (la primera promesa rechaza y los reintentos
    // fallan), sí se marca el fallo definitivo.
    d.reject(new Error('sin backend'));
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(p.read().configFailed).toBe(true);
  });

  it('applyConfig clears configFailed/configError and notifies onConfigChange', async () => {
    state.getConfig.mockRejectedValue(new Error('sin backend'));
    const onConfigChange = vi.fn();
    const p = probe({ onConfigChange });
    useFakeWindowTimers();
    p.load.run();
    // El arranque agota los reintentos → fallo definitivo.
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(p.read().configFailed).toBe(true);

    // Una config válida (p. ej. reintento manual) lo despeja y notifica.
    p.applyConfig({ locale: 'en' });
    expect(p.read().config).toEqual({ locale: 'en' });
    expect(p.read().configFailed).toBe(false);
    expect(p.read().configError).toBeNull();
    expect(onConfigChange).toHaveBeenCalledWith({ locale: 'en' });
  });

  it('a late startup read does not overwrite a newer config applied by config-changed (race)', async () => {
    useFakeWindowTimers();
    // El arranque queda pendiente; mientras tanto `config-changed` lee y aplica
    // una config más nueva.
    const startup = deferred();
    state.getConfig
      .mockReturnValueOnce(startup.promise)      // arranque (lento)
      .mockResolvedValueOnce({ locale: 'en' });  // config-changed (llega antes)
    const p = probe();
    p.load.run();

    const changed = state.listeners.get('config-changed')![0];
    await changed();
    await flush();
    expect(p.read().config).toEqual({ locale: 'en' });

    // El arranque resuelve DESPUÉS con una config vieja: no debe pisarla.
    startup.resolve({ locale: 'es' });
    await flush();
    expect(p.read().config).toEqual({ locale: 'en' });
    expect(p.read().configFailed).toBe(false);
  });

  it('placement showing before the timer does not change pending neutrality', async () => {
    useFakeWindowTimers();
    const d = deferred();
    state.getConfig.mockReturnValue(d.promise);
    const onReadyToShow = vi.fn();
    const p = probe({ onReadyToShow });

    p.load.run();
    // La colocación normal ya mostró la ventana; el temporizador aún no se
    // instaló/venció. El estado sigue pendiente (sin cadenas localizadas).
    expect(p.read()).toEqual({ config: null, configFailed: false, configError: null });
    // Ahora instalamos la red de seguridad y vence.
    p.timer.run();
    await vi.advanceTimersByTimeAsync(STARTUP_SHOW_DELAY_MS + 1);
    expect(onReadyToShow).toHaveBeenCalledTimes(1);
  });

  // Coherencia de la tabla de slots (#286): el render del probe consume
  // exactamente los useState que declara STARTUP_STATES, en orden y con los
  // iniciales esperados. Un useState de más en el hook (o un reordenamiento)
  // rompe este test pidiendo actualizar la tabla.
  it('the probe consumes exactly the useState declared in STARTUP_STATES, with matching initials', () => {
    state.stateIndex = 0;
    state.stateInitials = [];
    state.states = [];
    probe();
    expect(state.stateIndex).toBe(STARTUP_STATE_COUNT);
    STARTUP_STATES.forEach((spec, i) => {
      // `STARTUP_STATES` no declara SKIP hoy; el cast mantiene el oráculo
      // válido si la tabla lo usa en el futuro (#286).
      if ((spec.initial as unknown) === SKIP) return;
      expect(state.stateInitials[i], `initial de ${spec.name}`).toEqual(spec.initial);
    });
  });
});
