import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { api } from './api';
import type { EmailEvent, EmailStatus, Locale } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

// Merge #245: both public contracts must coexist. This checks only the mocked
// bridge, not native windows, configuration persistence, a keyring or delivery.
describe('merged locale and email bridge', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it.each<Locale>(['es', 'en'])('forwards the %s locale without email or config calls', async (locale) => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);

    expect(await api.chooseLocale(locale)).toBeUndefined();
    expect(vi.mocked(invoke).mock.calls).toEqual([['choose_locale', { locale }]]);
  });

  it('keeps the existing email status command argument-free and returns its result', async () => {
    const status: EmailStatus = 'keyMissing';
    vi.mocked(invoke).mockResolvedValueOnce(status);

    expect(await api.emailStatus()).toBe(status);
    expect(vi.mocked(invoke).mock.calls).toEqual([['email_status']]);
  });

  it.each<EmailEvent | null>([
    null,
    { provider: 'codex', meter: 'usage', window: '5h', percent: 85, kind: 'exceeded' },
    { provider: 'claude', meter: 'usage', window: '7d', percent: 0, kind: 'reset' },
  ])('keeps the existing explicit test or automatic email event unchanged: %j', async (event) => {
    const before = structuredClone(event);
    vi.mocked(invoke).mockResolvedValueOnce('accepted' satisfies EmailStatus);

    expect(await api.sendEmailAlert(event)).toBe('accepted');
    expect(vi.mocked(invoke).mock.calls).toEqual([['send_email_alert', { event: before }]]);
    expect(event).toEqual(before);
  });
});
