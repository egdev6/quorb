// T2c slice 1 (#66): el popup de detalle (ProviderCard + MeterBar + ValidityBadge)
// muestra sus textos de UI por catálogo; en `en` nada del frontend queda en español.
// Los labels largos de medidores y periodLabel siguen siendo datos de Rust (slice 3).
import { renderToStaticMarkup } from 'react-dom/server';
import { vi, afterEach, beforeEach, describe, expect, it } from 'vitest';

vi.mock('../lib/api', () => ({ api: { openLogin: vi.fn(), openSettings: vi.fn() } }));

import { ProviderCard } from './ProviderCard';
import type { UsageReport } from '../lib/types';

const report: UsageReport = {
  id: 'codex:work',
  name: 'Codex · Trabajo',
  kind: 'subscription',
  status: 'needsLogin',
  plan: null,
  meters: [
    { id: 'weekly', label: 'Semana · todos', percent: 40, used: null, limit: null, unit: null, resetsAt: '2026-10-06T10:45:00Z', windowSeconds: null },
  ],
  spend: { amount: 28.12, currency: 'USD', periodLabel: 'Este mes', budget: 40 },
  message: null,
  action: 'login',
  fetchedAt: '2026-10-06T10:00:00Z',
  stale: true,
};

describe('ProviderCard i18n (SSR)', () => {
  beforeEach(() => {
    // El reinicio del medidor se mide contra el reloj real: lo fijamos para que
    // «en 45 min» sea determinista (la fecha del fixture ya pasó).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('renders the Spanish UI texts verbatim for es', () => {
    const html = renderToStaticMarkup(<ProviderCard report={report} locale="es" />);
    expect(html).toContain('Sin sesión');
    expect(html).toContain('Renovar sesión');
    expect(html).toContain('caché');
    expect(html).toContain('Se reinicia en 45 min');
    expect(html).toContain('Presupuesto');
  });

  it('renders the English UI texts when the locale is en', () => {
    const html = renderToStaticMarkup(<ProviderCard report={report} locale="en" />);
    expect(html).toContain('Signed out');
    expect(html).toContain('Renew session');
    expect(html).toContain('cached');
    expect(html).toContain('Data from the last good cycle');
    expect(html).toContain('Resets in 45 min');
    expect(html).toContain('Budget');
    // Los labels largos y periodLabel son datos de Rust: se conservan (slice 3).
    expect(html).toContain('Semana · todos');
    expect(html).toContain('Este mes');
    expect(html).not.toContain('Se reinicia');
    expect(html).not.toContain('Sin sesión');
  });
});
