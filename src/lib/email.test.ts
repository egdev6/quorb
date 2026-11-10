import { describe, expect, it, vi } from 'vitest';
import { emailDefaults, emailReady, patchEmail, sendEmailTest } from './email';
import { api } from './api';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue('accepted') }));

const email = { enabled: false, consent: true, sender: 'sender@example.test', recipient: 'recipient@example.test' };

describe('email Settings actions', () => {
  it('defaults off, save does not enable, revocation disables, disable preserves config', () => {
    expect(emailDefaults).toEqual({ enabled: false, consent: false, sender: '', recipient: '' });
    expect(patchEmail(undefined, { sender: email.sender }).enabled).toBe(false);
    expect(patchEmail({ ...email, enabled: true }, { consent: false })).toEqual({ ...email, enabled: false, consent: false });
    expect(patchEmail({ ...email, enabled: true }, { enabled: false })).toEqual(email);
    expect(patchEmail(undefined, { enabled: true }).enabled).toBe(false);
  });

  it('requires explicit consent and valid addresses before persisting or sending', async () => {
    const persist = vi.fn(); const send = vi.fn();
    expect(emailReady(undefined)).toBe(false);
    expect(await sendEmailTest({ ...email, consent: false }, persist, send)).toBe('consentRequired');
    expect(await sendEmailTest({ ...email, sender: 'bad\r\naddress' }, persist, send)).toBe('configurationMissing');
    expect(persist).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('persists before one explicit test and never activates automatic sending', async () => {
    const order: string[] = [];
    const persist = vi.fn(async () => { order.push('save'); });
    const send = vi.fn(async () => { order.push('send'); return 'accepted' as const; });
    const before = { ...email };
    expect(await sendEmailTest(email, persist, send)).toBe('accepted');
    expect(order).toEqual(['save', 'send']); expect(send).toHaveBeenCalledTimes(1);
    expect(email).toEqual(before); expect(email.enabled).toBe(false);
  });

  it('failed save does not send and diagnostics never echo errors', async () => {
    const send = vi.fn();
    const persist = vi.fn().mockRejectedValue('private-address secret-value');
    expect(await sendEmailTest(email, persist, send)).toBe('serviceError');
    expect(send).not.toHaveBeenCalled();
    expect(await sendEmailTest(email, async () => {}, vi.fn().mockRejectedValue('private'))).toBe('acceptanceUnknown');
  });

  it('the public bridge sends no key or configuration and separates status from test', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await api.sendEmailAlert(null);
    expect(invoke).toHaveBeenLastCalledWith('send_email_alert', { event: null });
    await api.emailStatus();
    expect(invoke).toHaveBeenLastCalledWith('email_status');
  });
});
