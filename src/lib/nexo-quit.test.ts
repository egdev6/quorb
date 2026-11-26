import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createLiveSaver } from './settings-live';
import { quitStateFrom, registerNexoQuitState } from './nexo-quit';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const live = (over: Partial<{ saving: boolean; pending: boolean; error: string | null; saveError: string | null }> = {}) => ({
  saving: false,
  pending: false,
  error: null,
  saveError: null,
  ...over,
});

describe('quitStateFrom', () => {
  it('no bloquea sin cambios, guardado en curso ni fallos', () => {
    expect(quitStateFrom({ dirty: false, manualSaving: false, live: live() })).toEqual({
      dirty: false,
      saving: false,
      failed: false,
      applyFailed: false,
    });
  });

  it('marca saving con un guardado manual, vivo o pendiente', () => {
    expect(quitStateFrom({ dirty: false, manualSaving: true, live: live() }).saving).toBe(true);
    expect(quitStateFrom({ dirty: false, manualSaving: false, live: live({ saving: true }) }).saving).toBe(true);
    expect(quitStateFrom({ dirty: false, manualSaving: false, live: live({ pending: true }) }).saving).toBe(true);
  });

  it('marca failed cuando un autoguardado quedó sin resolver', () => {
    expect(quitStateFrom({ dirty: false, manualSaving: false, live: live({ error: 'disk full', saveError: 'disk full' }) })).toEqual({
      dirty: false,
      saving: false,
      failed: true,
      applyFailed: false,
    });
  });

  it('distingue el fallo de efecto nativo del fallo de escritura', () => {
    // El dato quedó guardado: lo que falló fue aplicarlo.
    expect(quitStateFrom({ dirty: false, manualSaving: false, live: live({ error: 'always on top failed' }) })).toEqual({
      dirty: false,
      saving: false,
      failed: false,
      applyFailed: true,
    });
  });

  it('mantiene dirty para los cambios manuales sin guardar', () => {
    expect(quitStateFrom({ dirty: true, manualSaving: false, live: live() })).toEqual({
      dirty: true,
      saving: false,
      failed: false,
      applyFailed: false,
    });
  });
});

describe('un autoguardado fallido bloquea la salida', () => {
  it('el saver real queda sin trabajo pendiente pero con error, y eso debe bloquear', async () => {
    // Caso del mantenedor: la escritura de un campo vivo se rechaza, así que el
    // saver termina en `saving:false, pending:false` con el error puesto. Si el
    // estado que ve Nexo no lo mira, la salida se acepta y el cambio se pierde.
    const saver = createLiveSaver({ delay: 0, save: () => Promise.reject(new Error('disk full')) });
    saver.push({ orbSize: 40 });
    await saver.flush().catch(() => {});

    const snapshot = saver.getState();
    expect(snapshot).toMatchObject({ saving: false, pending: false });
    expect(snapshot.error).not.toBeNull();
    expect(snapshot.saveError).not.toBeNull();
    expect(saver.hasUnresolved()).toBe(true);
    expect(quitStateFrom({ dirty: false, manualSaving: false, live: snapshot })).toEqual({
      dirty: false,
      saving: false,
      failed: true,
      applyFailed: false,
    });
    saver.dispose();
  });

  it('un error nativo tras persistir bloquea, pero como fallo de efecto y no de escritura', async () => {
    // El backend persistió la configuración y solo falló el efecto nativo: el
    // dato está guardado, así que el motivo no puede ser «no se pudo guardar».
    const saver = createLiveSaver({
      delay: 0,
      save: () => Promise.resolve({ config: {} as never, nativeError: 'always on top failed' }),
    });
    saver.push({ alwaysOnTop: true });
    await saver.flush().catch(() => {});

    const snapshot = saver.getState();
    expect(snapshot).toMatchObject({ saving: false, pending: false });
    expect(snapshot.error).not.toBeNull();
    expect(snapshot.saveError).toBeNull();
    expect(quitStateFrom({ dirty: false, manualSaving: false, live: snapshot })).toEqual({
      dirty: false,
      saving: false,
      failed: false,
      applyFailed: true,
    });
    saver.dispose();
  });
});

describe('registerNexoQuitState', () => {
  // El listener vive a nivel de módulo: se registra una sola vez, así que el
  // handler se comparte entre los tests de este bloque.
  const captured: { handler?: (event: { payload: number }) => void } = {};

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockImplementation((_event, cb) => {
      captured.handler = cb as unknown as (event: { payload: number }) => void;
      return Promise.resolve(() => {});
    });
  });

  it('reporta al hub el token y el estado vigente de Ajustes', async () => {
    const state = { dirty: false, saving: false, failed: false, applyFailed: false };
    registerNexoQuitState(() => state);
    await vi.waitFor(() => expect(captured.handler).toBeDefined());

    captured.handler?.({ payload: 7 });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('nexo_quit_answer', {
        token: 7,
        dirty: false,
        saving: false,
        failed: false,
        applyFailed: false,
      }),
    );

    // Se lee el estado del momento, no el del registro: un fallo posterior llega
    // a la siguiente petición.
    state.failed = true;
    captured.handler?.({ payload: 8 });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('nexo_quit_answer', {
        token: 8,
        dirty: false,
        saving: false,
        failed: true,
        applyFailed: false,
      }),
    );
  });

  it('sin lector no responde, para que el timeout del plugin rechace', async () => {
    // El lector se da de baja (p. ej. Ajustes se desmonta) pero el listener sigue
    // vivo: sin lector no se sabe si hay cambios sin guardar, así que no se
    // responde «se puede salir» a ciegas.
    const unregister = registerNexoQuitState(() => ({ dirty: false, saving: false, failed: false, applyFailed: false }));
    await vi.waitFor(() => expect(captured.handler).toBeDefined());
    unregister();

    captured.handler?.({ payload: 9 });
    await vi.waitFor(() => expect(invoke).not.toHaveBeenCalled());
  });
});
