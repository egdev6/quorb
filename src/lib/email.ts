import type { AlertEvent } from './alerts';
import type { AlertsConfig, EmailAlertsConfig, EmailEvent, EmailStatus } from './types';

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

/** Consume solo los eventos ya emitidos: sin deduplicador, historial ni replay propios. */
export async function dispatchEmailAlerts(
  events: AlertEvent[],
  alerts: AlertsConfig,
  send: (event: EmailEvent) => Promise<EmailStatus>,
): Promise<void> {
  if (!alerts.enabled || !alerts.email?.enabled || !emailReady(alerts.email)) return;
  await Promise.all(events.map(async (event) => {
    // Los ids de cuenta y etiquetas configurables se quedan en el aviso local.
    const payload: EmailEvent = {
      provider: event.providerId.split(':', 1)[0],
      meter: /^[a-z0-9_]{1,64}$/.test(event.realMeterId) ? event.realMeterId : 'usage',
      window: event.window,
      percent: event.percent,
      kind: event.kind,
    };
    try { await send(payload); } catch { /* El resultado remoto nunca bloquea el aviso local. */ }
  }));
}
