// Feedback visible del resultado de la prueba de email (#245 S22) y su i18n
// (S21): EmailStatusLine en servidor (renderToStaticMarkup, sin DOM falso)
// para los trece estados de EmailStatus en español e inglés, con el tono del
// patrón existente «eg-notice eg-notice--sm» y la letra de S20: el éxito
// expresa «Solicitud aceptada por Resend», nunca entrega en el buzón.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
