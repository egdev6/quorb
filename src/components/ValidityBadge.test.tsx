import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ValidityBadge } from './ValidityBadge';
import { ProviderCard } from './ProviderCard';
import { ProviderGauge } from './ProviderGauge';
import type { UsageReport } from '../lib/types';

const report: UsageReport = {
  id: 'codex:work', name: 'Codex · Trabajo', kind: 'subscription', status: 'ok', plan: 'Plus',
  meters: [], spend: null, message: null, action: null, fetchedAt: '2030-01-01T00:00:00Z',
};
const withDate = (kind: 'period' | 'key'): UsageReport => ({
  ...report, validity: { kind, at: '2030-02-01T00:00:00Z' },
});

const withBalance = (count: unknown): UsageReport & { availableResets: number } => ({
  ...report, availableResets: count as number,
});

describe('banked reset badges', () => {
  it.each([0, 2])('can hide compact resets (%s) without hiding the account identity', (count) => {
    const html = renderToStaticMarkup(<ProviderGauge report={withBalance(count)} account="2" small={false} size={56} active={false} onHover={() => {}} {...{ showResets: false }} />);
    expect(html).not.toContain('data-kind="resets"');
    expect(html).not.toContain('reset disponible');
    expect(html).not.toContain('resets disponibles');
    expect(html).toContain('orb__acct');
    expect(html).toContain('data-account="2"');
  });

  it('keeps period validity and popup reset balances when compact resets are hidden', () => {
    const r = { ...withDate('period'), availableResets: 2 };
    const compact = renderToStaticMarkup(<ValidityBadge report={r} compact {...{ showResets: false }} />);
    expect(compact).toContain('data-kind="period"');
    expect(compact).not.toContain('data-kind="resets"');
    const popup = renderToStaticMarkup(<ValidityBadge report={r} {...{ showResets: false }} />);
    expect(popup).toContain('2 resets disponibles');
  });
  it.each([[0, '0 resets disponibles'], [1, '1 reset disponible'], [2, '2 resets disponibles']])(
    'shows banked %s without validity or quota metadata', (count, label) => {
      const html = renderToStaticMarkup(<ValidityBadge report={withBalance(count)} />);
      expect(html).toContain('data-kind="resets"');
      expect(html).toContain(`<span>${label}</span>`);
      expect(html).toContain('<svg');
      expect(html).toContain('<path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5"');
      expect(html).not.toMatch(/<time|caduca|Periodo hasta/);
    },
  );

  it.each([0, 2, 4294967295])('shares the popup restart SVG with the compact banked %s badge', (count) => {
    const html = renderToStaticMarkup(<ValidityBadge report={withBalance(count)} compact />);
    const expanded = renderToStaticMarkup(<ValidityBadge report={withBalance(count)} />);
    expect(html).toContain(`<span>${count > 99 ? '99+' : count}</span>`);
    expect(html).toContain('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5"');
    expect(html.match(/<svg.*?<\/svg>/)?.[0]).toBe(expanded.match(/<svg.*?<\/svg>/)?.[0]);
    expect(html).not.toContain('↻');
  });

  it('hides unknown, invalid, stale, failed and non-Codex balances', () => {
    const hidden = [report, ...[null, undefined, -1, 0.5, true, '2', Infinity, 4294967296].map(withBalance),
      { ...withBalance(2), stale: true }, { ...withBalance(2), id: 'claude:work' },
      ...(['error', 'needsLogin', 'unconfigured'] as const).map((status) => ({ ...withBalance(2), status }))];
    for (const r of hidden) expect(renderToStaticMarkup(<ValidityBadge report={r} />)).toBe('');
  });

  it('combines a period and balance in one compact chip while preserving the period caveat', () => {
    const r = { ...withDate('period'), availableResets: 2 };
    const expanded = renderToStaticMarkup(<ValidityBadge report={r} />);
    expect(expanded).toContain('Periodo hasta');
    expect(expanded).toContain('no confirma cancelación');
    expect(expanded).toContain('2 resets disponibles');
    expect(expanded).not.toContain('caduca');
    for (const size of [24, 56, 80]) {
      const html = renderToStaticMarkup(<ProviderGauge report={r} account="2" small={size === 24} size={size} active={true} onHover={() => {}} />);
      const button = html.slice(0, html.indexOf('>'));
      expect(button).toMatch(/aria-label="Codex · Trabajo · Periodo hasta[^\"]*2 resets disponibles/);
      expect(button).toMatch(/title="Codex · Trabajo · Periodo hasta[^\"]*2 resets disponibles/);
      expect(button).toContain('no confirma cancelación');
      expect(button).toContain('aria-expanded="true"');
      expect(html.match(/q-validity--compact/g)).toHaveLength(1);
      expect(html).toContain('data-kind="resets"');
      expect(html).not.toContain('↻');
      expect(html).toContain('<path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5"');
      expect(html).toContain('<span>2</span>');
      expect(html).toContain('orb__acct');
      expect(html).not.toContain('<time');
    }
  });

  it('exposes the numeric balance and account identity on a date-free compact button', () => {
    const html = renderToStaticMarkup(<ProviderGauge report={withBalance(2)} small={false} size={56} active={false} onHover={() => {}} />);
    expect(html).toContain('aria-label="Codex · Trabajo · 2 resets disponibles');
    expect(html).toContain('title="Codex · Trabajo · 2 resets disponibles');
    expect(html).toContain('<span>2</span>');
  });

  it.each([24, 56, 80])('caps compact text at 99+ at size %s while keeping the full server balance accessible', (size) => {
    const r = withBalance(4294967295);
    const html = renderToStaticMarkup(<ProviderGauge report={r} small={size === 24} size={size} active={false} onHover={() => {}} />);
    expect(html).toContain('<span>99+</span>');
    expect(html).toContain('aria-label="Codex · Trabajo · 4294967295 resets disponibles');
    expect(html).toContain('title="Codex · Trabajo · 4294967295 resets disponibles');
    expect(renderToStaticMarkup(<ValidityBadge report={r} />)).toContain('<span>4294967295 resets disponibles</span>');
  });

  it('places the expanded balance after both meters and spend stats', () => {
    const r = { ...withBalance(2), meters: [{ id: '', label: 'Semana', percent: 40, used: 2, limit: 5,
      unit: null, resetsAt: null, windowSeconds: 604800 }],
      spend: { amount: 5, currency: 'USD', periodLabel: 'Este mes', budget: 10 } };
    const html = renderToStaticMarkup(<ProviderCard report={r} />);
    expect(html.indexOf('2 resets disponibles')).toBeGreaterThan(html.indexOf('q-card__stats'));
    expect(html.indexOf('2 resets disponibles')).toBeGreaterThan(html.indexOf('q-card__meters'));
  });
});

describe('localized validity and reset badges (T2c-S1)', () => {
  it('renders key expiry in English through the locale prop', () => {
    const html = renderToStaticMarkup(<ValidityBadge report={withDate('key')} locale="en" />);
    expect(html).toContain('Key expires');
    expect(html).toContain('Provider-reported key expiry');
  });

  it('renders banked balances in English through the locale prop', () => {
    const html = renderToStaticMarkup(<ValidityBadge report={withBalance(2)} locale="en" />);
    expect(html).toContain('2 resets available');
  });
});

describe('available validity badges', () => {
  it('shows nothing without a valid date, with stale data or a failed account', () => {
    const invalid = [report, { ...report, validity: null }, { ...withDate('period'), stale: true },
      ...['invalid', '', '2030-02-30T00:00:00Z'].map((at) => ({ ...withDate('key'), validity: { kind: 'key' as const, at } })),
      ...(['needsLogin', 'error', 'unconfigured'] as const).map((status) => ({ ...withDate('period'), status }))];
    for (const r of invalid) expect(renderToStaticMarkup(<ValidityBadge report={r} />)).toBe('');
  });

  it('distinguishes period end from API key expiration with icons and dates', () => {
    const period = renderToStaticMarkup(<ValidityBadge report={withDate('period')} />);
    const key = renderToStaticMarkup(<ValidityBadge report={withDate('key')} />);
    expect(period).toContain('Periodo hasta');
    expect(key).toContain('Clave caduca');
    for (const html of [period, key]) {
      expect(html).toContain('<svg');
      expect(html).toContain('<time dateTime="2030-02-01T00:00:00Z">');
      expect(html).toContain('2030');
      expect(html).not.toMatch(/reinicios|resets|estimad/);
    }
  });

  it('keeps account identity and other badges, and places validity after all consumption', () => {
    const r = { ...withDate('period'), spend: { amount: 5, currency: 'USD', periodLabel: 'Este mes', budget: 10 } };
    const card = renderToStaticMarkup(<ProviderCard report={r} />);
    const gauge = renderToStaticMarkup(<ProviderGauge report={r} account="2" small={false} size={56} active={false} onHover={() => {}} />);
    expect(card).toContain('Plus');
    expect(card.indexOf('q-validity')).toBeGreaterThan(card.indexOf('q-card__stats'));
    expect(gauge).toContain('q-validity--compact');
    expect(gauge).toContain('orb__acct');
    expect(gauge).toContain('data-account="2"');
    expect(gauge).toMatch(/aria-label="Codex · Trabajo · Periodo hasta/);
    expect(gauge).not.toContain('<time');
    expect(renderToStaticMarkup(<ProviderGauge report={report} small={false} size={56} active={false} onHover={() => {}} />)).not.toContain('q-validity');
  });
});
