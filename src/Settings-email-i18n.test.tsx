// Feedback visible del resultado de la prueba de email (#245 S22) y su i18n
// (S21): EmailStatusLine en servidor (renderToStaticMarkup, sin DOM falso)
// para los trece estados de EmailStatus en español e inglés, con el tono del
// patrón existente «eg-notice eg-notice--sm» y la letra de S20: el éxito
// expresa «Solicitud aceptada por Resend», nunca entrega en el buzón.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertsSection, EmailStatusLine } from './Settings';
import { en } from './i18n/en';
import { es } from './i18n/es';
import type { AlertsConfig, EmailStatus } from './lib/types';

const STATUSES: EmailStatus[] = [
  'idle',
  'accepted',
  'disabled',
  'consentRequired',
  'configurationMissing',
  'keyMissing',
  'keyringError',
  'authenticationError',
  'senderRejected',
  'requestRejected',
  'rateLimited',
  'serviceError',
  'acceptanceUnknown',
];

// Tono del patrón eg-notice por estado: éxito verde, avisos de requisito o
// incertidumbre en amarillo y fallos del envío en rojo; neutros sin tono.
const TONES: Record<EmailStatus, '' | 'eg-notice--success' | 'eg-notice--warning' | 'eg-notice--danger'> = {
  idle: '',
  disabled: '',
  accepted: 'eg-notice--success',
  consentRequired: 'eg-notice--warning',
  configurationMissing: 'eg-notice--warning',
  keyMissing: 'eg-notice--warning',
  keyringError: 'eg-notice--danger',
  authenticationError: 'eg-notice--danger',
  senderRejected: 'eg-notice--danger',
  requestRejected: 'eg-notice--danger',
  rateLimited: 'eg-notice--danger',
  serviceError: 'eg-notice--danger',
  acceptanceUnknown: 'eg-notice--warning',
};

const noop = () => {};

const statusText = (locale: 'es' | 'en', status: EmailStatus): string =>
  (locale === 'es' ? es : en).settings.alerts.email.status[status];

const line = (locale: 'es' | 'en', status: EmailStatus) =>
  renderToStaticMarkup(<EmailStatusLine locale={locale} status={status} />);

describe('EmailStatusLine (SSR, i18n)', () => {
  it('renders the visible status feedback for every EmailStatus in Spanish and English', () => {
    for (const status of STATUSES) {
      for (const locale of ['es', 'en'] as const) {
        const html = line(locale, status);
        expect(html, `rol de estado para ${status}/${locale}`).toContain('role="status"');
        const tone = TONES[status];
        expect(html, `tono para ${status}/${locale}`).toContain(
          tone === '' ? 'eg-notice eg-notice--sm"' : `eg-notice eg-notice--sm eg-notice--${tone.replace('eg-notice--', '')}"`,
        );
        expect(html, `texto traducido para ${status}/${locale}`).toContain(statusText(locale, status));
        // Sin clave en el catálogo, t() devuelve la clave: nunca debe verse.
        expect(html, `clave sin traducir para ${status}/${locale}`).not.toContain('settings.alerts.email.status');
      }
    }
  });

  it.each([
    ['es', 'authenticationError', 'Resend rechazó la clave.'],
    ['en', 'authenticationError', 'Resend rejected the key.'],
    ['es', 'senderRejected', 'Resend rechazó remitente, destinatario o dominio. Revisa las restricciones de pruebas.'],
    ['en', 'senderRejected', 'Resend rejected the sender, recipient or domain. Check testing restrictions.'],
  ] as const)('renders %s/%s without a fixed HTTP code', (locale, status, text) => {
    const html = line(locale, status);
    expect(html).toBe(`<p class="eg-notice eg-notice--sm eg-notice--danger" role="status">${text}</p>`);
    expect(html).not.toMatch(/\b[1-5]\d{2}\b/);
  });

  it('acceptance states «Solicitud aceptada por Resend», never inbox delivery (S20)', () => {
    expect(statusText('es', 'accepted')).toBe('Solicitud aceptada por Resend');
    expect(statusText('en', 'accepted')).toBe('Request accepted by Resend');
    for (const catalog of [es, en]) {
      for (const [key, value] of Object.entries(catalog.settings.alerts.email.status)) {
        expect(value, `texto de entrega en ${key}`).not.toMatch(/entregad|bandeja|inbox|deliver/i);
      }
    }
  });
});

describe('AlertsSection email feedback (SSR, S22)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const alertsCfg = {
    enabled: true,
    native: true,
    threshold: 80,
    exceededEffect: 'confetti',
    onReset: true,
    resetEffect: 'custom',
    exceededMedia: null,
    resetMedia: 'C:/efectos/anim.gif',
    mediaSize: 'small',
    mediaSound: false,
    email: { enabled: false, consent: true, sender: 'sender@example.test', recipient: 'recipient@example.test' },
  } as AlertsConfig;

  it('explains the Resend test sender and account-recipient restriction without prefilling the sender', () => {
    for (const locale of ['es', 'en'] as const) {
      const html = renderToStaticMarkup(
        <AlertsSection locale={locale} alerts={{ ...alertsCfg, email: undefined }} onAlerts={noop} onPersist={async () => {}} onError={noop} />,
      );
      expect(html).toContain('onboarding@resend.dev');
      expect(html).not.toContain('value="onboarding@resend.dev"');
      expect(html).toContain(locale === 'es'
        ? 'Sin dominio propio, usa onboarding@resend.dev para pruebas hacia el correo de tu cuenta de Resend. Para otros destinatarios, usa un remitente de tu dominio verificado.'
        : 'Without your own domain, use onboarding@resend.dev for tests to your Resend account email. For other recipients, use a sender from your verified domain.');
      expect(html).toContain('type="email" autoComplete="off" value=""');
    }
  });

  it('shows a plain-language restart warning only on Linux, in both languages', () => {
    for (const userAgent of ['Mozilla/5.0 (X11; Linux x86_64)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'Mozilla/5.0 (Windows NT 10.0)']) {
      vi.stubGlobal('navigator', { userAgent });
      for (const locale of ['es', 'en'] as const) {
        const html = renderToStaticMarkup(
          <AlertsSection locale={locale} alerts={alertsCfg} onAlerts={noop} onPersist={async () => {}} onError={noop} />,
        );
        const warning = locale === 'es'
          ? 'En algunos sistemas Linux, tendrás que volver a introducir la clave después de reiniciar.'
          : 'On some Linux systems, you will need to enter the key again after restarting.';
        if (userAgent.includes('Linux')) expect(html).toContain(warning);
        else expect(html).not.toContain(warning);
        expect(html).not.toMatch(/keyutils|backend|#106/);
        expect(html).toContain(statusText(locale, 'idle'));
      }
    }
  });

  it('keeps the test save/send effects and consent/key requirements in concise help', () => {
    for (const locale of ['es', 'en'] as const) {
      const html = renderToStaticMarkup(
        <AlertsSection locale={locale} alerts={alertsCfg} onAlerts={noop} onPersist={async () => {}} onError={noop} />,
      );
      expect(html).toContain(locale === 'es'
        ? 'Guarda los cambios y envía una prueba sin datos de consumo. Requiere consentimiento y clave guardada. No activa los avisos automáticos.'
        : 'Saves changes and sends a test without usage data. Requires consent and a saved key. Does not enable automatic alerts.');
      expect(html).toContain(locale === 'es' ? 'Sin reintentos' : 'No retries');
      expect(html).toContain(locale === 'es' ? 'Resend procesa' : 'Resend processes');
    }
  });

  it('shows the idle status feedback inside Alertas before any test send', () => {
    for (const locale of ['es', 'en'] as const) {
      const html = renderToStaticMarkup(
        <AlertsSection locale={locale} alerts={alertsCfg} onAlerts={noop} onPersist={async () => {}} onError={noop} />,
      );
      expect(html, `estado inicial visible en ${locale}`).toContain(statusText(locale, 'idle'));
      expect(html, `rol de estado en ${locale}`).toContain('role="status"');
    }
  });
});
