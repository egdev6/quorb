import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { registerNexoQuitState } from './nexo-quit';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

describe('registerNexoQuitState', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.mocked(listen).mockReset();
  });

  it('reporta al hub el token y el estado vigente de Ajustes', async () => {
    const captured: { handler?: (event: { payload: number }) => void } = {};
    vi.mocked(listen).mockImplementation((_event, cb) => {
      captured.handler = cb as unknown as (event: { payload: number }) => void;
      return Promise.resolve(() => {});
    });

    const state = { dirty: false, saving: false };
    registerNexoQuitState(() => state);
    await vi.waitFor(() => expect(captured.handler).toBeDefined());

    captured.handler?.({ payload: 7 });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('nexo_quit_answer', { token: 7, dirty: false, saving: false }));

    // Se lee el estado del momento, no el del registro: un cambio posterior
    // llega a la siguiente petición.
    state.dirty = true;
    state.saving = true;
    captured.handler?.({ payload: 8 });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('nexo_quit_answer', { token: 8, dirty: true, saving: true }));
  });
});
