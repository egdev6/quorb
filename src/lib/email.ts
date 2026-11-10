import type { EmailAlertsConfig, EmailStatus } from './types';

export const emailDefaults: EmailAlertsConfig = { enabled: false, consent: false, sender: '', recipient: '' };

export function patchEmail(current: EmailAlertsConfig | undefined, patch: Partial<EmailAlertsConfig>): EmailAlertsConfig {
  const next = { ...emailDefaults, ...current, ...patch };
  if (!next.consent) next.enabled = false;
  return next;
}

const validAddress = (value: string) => value.length <= 254
  && /^[\x21-\x7e]+$/.test(value) && !/[<>,;"\\]/.test(value)
  && /^[^@]+@[^@.][^@]*\.[^@.]+$/.test(value);

export function emailReady(email: EmailAlertsConfig | undefined): boolean {
  return !!email?.consent && validAddress(email.sender) && validAddress(email.recipient);
}

/** Acción de prueba explícita: guardar no cambia enabled; nunca reintenta. */
export async function sendEmailTest(
  email: EmailAlertsConfig,
  persist: () => Promise<void>,
  send: () => Promise<EmailStatus>,
): Promise<EmailStatus> {
  if (!email.consent) return 'consentRequired';
  if (!emailReady(email)) return 'configurationMissing';
  try { await persist(); } catch { return 'serviceError'; }
  try { return await send(); } catch { return 'acceptanceUnknown'; }
}
