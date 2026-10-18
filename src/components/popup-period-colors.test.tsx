import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meter, Sample, UsageReport } from '../lib/types';
import { ProviderCard } from './ProviderCard';
import { ProviderDetails } from './ProviderDetails';
import { ProviderGauge } from './ProviderGauge';

// SSR never runs the history effect. Seed only its null state, not disclosures.
const history = vi.hoisted(() => ({ samples: null as Sample[] | null }));
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal() as typeof import('react');
  return {
    ...react,
    useState: ((initial: unknown) => react.useState(
      initial === null && history.samples !== null ? history.samples : initial,
    )) as typeof react.useState,
  };
});
afterEach(() => {
  history.samples = null;
  vi.unstubAllGlobals();
});

const hour = 5 * 3600;
const day = 86400;
const week = 7 * day;
const white = '#ffffff';
const accent = 'var(--popup-primary, #ff0036)';
const palette = (n: number) => `var(--ring-${n})`;
const meter = (label: string, windowSeconds: number, percent: number | null = 25): Meter => ({
  label, windowSeconds, percent, used: null, limit: null, unit: null,
  resetsAt: '2099-01-01T00:00:00Z',
});
const report = (meters: Meter[], id = 'codex:work', kind: UsageReport['kind'] = 'subscription'): UsageReport => ({
  id, kind, meters, name: id, status: 'ok', plan: null, spend: null,
  message: null, action: null, fetchedAt: '2098-12-31T00:00:00Z',
});

// Accept direct meter colors or inherited popup ring declarations. Do not require
// a new helper/export, or mistake the widget's unresolved palette for popup white.
function popupColor(html: string, color: string): string {
  const token = /^var\((--ring-[123])\)$/.exec(color)?.[1];
  if (!token) return color;
  const root = html.match(/^<div\b[^>]*>/)?.[0] ?? '';
  return root.match(new RegExp(`${token}:([^;\"]+)`))?.[1] ?? color;
}

const surfaces = [
  {
    name: 'card bars',
    render: (r: UsageReport) => renderToStaticMarkup(<ProviderCard report={r} />),
    colors: /class="q-meter"[^>]*style="[^"]*--meter-color:([^;"]+)/g,
  },
  {
    name: 'pace fills',
    render: (r: UsageReport) => renderToStaticMarkup(<ProviderDetails report={r} />),
    colors: /class="pace__fill" style="[^"]*background:([^;"]+)/g,
  },
  {
    name: 'history series',
    render: (r: UsageReport) => {
      history.samples = r.meters.filter(m => m.percent != null).flatMap(m =>
        [1, 2].map(t => ({ t, p: r.id, l: m.label, v: m.percent! })),
      );
      return renderToStaticMarkup(<ProviderDetails report={r} />);
    },
    colors: /<polyline[^>]*stroke="([^"]+)"/g,
  },
];

const layouts = [
  {
    name: 'session then weekly',
    meters: [meter('Session', hour), meter('Week', week)],
    expected: [white, accent],
  },
  {
    name: 'weekly then session',
    meters: [meter('Week', week), meter('Session', hour)],
    expected: [accent, white],
  },
  {
    name: 'nine-day weekly and daily quota sharing main palette slot three',
    meters: [meter('Nine days', 9 * day), meter('Session', hour), meter('Daily', day)],
    expected: [accent, white, palette(3)],
  },
  {
    name: 'repeated weekly quotas around a session, including the fourth quota',
    meters: [meter('Week · all', week), meter('Session', hour), meter('Week · Sonnet', week), meter('Week · Opus', week)],
    expected: [accent, white, accent, accent],
  },
];

describe.each(surfaces)('popup period colors: $name', ({ render, colors }) => {
  const renderedColors = (r: UsageReport) => {
    const html = render(r);
    return [...html.matchAll(colors)].map(m => popupColor(html, m[1]));
  };

  describe.each(['claude', 'codex:work', 'nan'])('%s subscription', id => {
    it.each(layouts)('uses white sessions and weekly accent for $name', ({ meters, expected }) => {
      expect(renderedColors(report(meters, id))).toEqual(expected);
    });
  });

  it.each([
    { name: 'session only', r: report([meter('Session', hour)]), expected: [palette(2)] },
    { name: 'weekly only', r: report([meter('Week', week)]), expected: [palette(1)] },
    { name: 'session and monthly', r: report([meter('Session', hour), meter('Month', 30 * day)]), expected: [palette(2), palette(3)] },
    { name: 'unknown session percentage', r: report([meter('Session', hour, null), meter('Week', week)]), expected: [palette(1)] },
    { name: 'unknown weekly percentage', r: report([meter('Session', hour), meter('Week', week, null)]), expected: [palette(2)] },
    { name: 'model quota without a pair', r: report([meter('Session', hour)], 'nan'), expected: [palette(1)] },
    { name: 'API with period metadata', r: report(layouts[0].meters, 'openrouter', 'api'), expected: [palette(1), palette(2)] },
    { name: 'API on a period-colored provider', r: report(layouts[0].meters, 'codex:work', 'api'), expected: [palette(2), palette(1)] },
    { name: 'empty report', r: report([]), expected: [] },
  ])('preserves main colors for $name', ({ r, expected }) => {
    expect(renderedColors(r)).toEqual(expected);
  });
});

describe('popup-only boundaries', () => {
  it.each(layouts)('leaves widget palette unchanged for $name', ({ meters }) => {
    const html = renderToStaticMarkup(
      <ProviderGauge report={report(meters)} small={false} size={48} active={false} onHover={() => {}} />,
    );
    expect([...html.matchAll(/class="eg-gauge__ring" style="[^"]*--c:([^;"]+)/g)].map(m => m[1]))
      .toEqual(meters.slice(0, 3).map(m => palette(
        m.windowSeconds! < day ? 2 : m.windowSeconds! >= 6 * day && m.windowSeconds! <= 8 * day ? 1 : 3,
      )));
    expect(html).not.toContain('--popup-primary');
    expect(html).not.toContain('#ffffff');
  });

  it('keeps the compact widget peak on its selected palette', () => {
    const html = renderToStaticMarkup(
      <ProviderGauge report={report([meter('Week', week, 10), meter('Session', hour, 95)])}
        small size={32} active={false} onHover={() => {}} />,
    );
    expect([...html.matchAll(/class="eg-gauge__ring" style="[^"]*--c:([^;"]+)/g)].map(m => m[1]))
      .toEqual([palette(2)]);
  });

  it.each([
    { pace: false, history: true },
    { pace: true, history: false },
    { pace: true, history: true },
    { pace: false, history: false },
  ])('retains independent account disclosures with popup colors: %j', ({ pace, history: historyOpen }) => {
    const r = report(layouts[0].meters);
    const stored: Record<string, string> = {
      [`popup:${r.id}:pace`]: String(pace),
      [`popup:${r.id}:history`]: String(historyOpen),
    };
    const getItem = vi.fn((key: string) => stored[key] ?? null);
    vi.stubGlobal('localStorage', { getItem });
    const html = renderToStaticMarkup(<ProviderDetails report={r} />);
    const sections = html.match(/<details\b[^>]*>/g) ?? [];
    expect(sections).toHaveLength(2);
    expect(sections.map(s => s.includes('open=""'))).toEqual([pace, historyOpen]);
    expect(getItem).toHaveBeenCalledWith(`popup:${r.id}:pace`);
    expect(getItem).toHaveBeenCalledWith(`popup:${r.id}:history`);
    expect(html).not.toMatch(/<details[^>]* name=/);
  });
});
