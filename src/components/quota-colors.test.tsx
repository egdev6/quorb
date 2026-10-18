import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meter, Sample, UsageReport } from '../lib/types';
import { ProviderGauge } from './ProviderGauge';
import { ProviderCard } from './ProviderCard';
import { ProviderDetails } from './ProviderDetails';
const { readFileSync } = await vi.importActual<{ readFileSync(path: URL, encoding: string): string }>('node:fs');
const theme = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');

// SSR does not run effects: seed the history state without a DOM or Tauri calls.
const history = vi.hoisted(() => ({ samples: null as Sample[] | null }));
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal() as typeof import('react');
  return {
    ...react,
    useState: ((initial: unknown) => {
      const seeded = initial === null && history.samples !== null ? history.samples : initial;
      return react.useState(seeded);
    }) as typeof react.useState,
  };
});
afterEach(() => {
  history.samples = null;
  vi.useRealTimers();
});

const hour = 5 * 3600;
const day = 86400;
const week = 7 * day;
const meter = (label: string, windowSeconds: number | null, percent: number | null = 25): Meter => ({
  label, windowSeconds, percent, used: null, limit: null, unit: null,
  resetsAt: '2099-01-01T00:00:00Z',
});
const report = (meters: Meter[], id = 'codex', kind: UsageReport['kind'] = 'subscription'): UsageReport => ({
  id, kind, meters, name: id, status: 'ok', plan: null, spend: null, message: null,
  action: null, fetchedAt: '2098-12-31T00:00:00Z',
});
const palette = (n: number) => `var(--ring-${n})`;
const gauge = (r: UsageReport, small = false, size = 48) => renderToStaticMarkup(
  <ProviderGauge report={r} small={small} size={size} active={false} onHover={() => {}} />,
);
const ringColors = (r: UsageReport, small = false, size = 48) => [...gauge(r, small, size)
  .matchAll(/class="eg-gauge__ring" style="[^"]*--c:([^;"]+)/g)].map(m => m[1]);
const barColors = (r: UsageReport) => [...renderToStaticMarkup(<ProviderCard report={r} />)
  .matchAll(/class="q-meter"[^>]*style="[^"]*--meter-color:([^;"]+)/g)].map(m => m[1]);
const details = (r: UsageReport) => renderToStaticMarkup(<ProviderDetails report={r} />);
const paceColors = (r: UsageReport) => [...details(r)
  .matchAll(/class="pace__fill" style="[^"]*background:([^;"]+)/g)].map(m => m[1]);

function historyColors(r: UsageReport) {
  history.samples = r.meters.flatMap(m => [1, 2].map(t => ({ t, p: r.id, l: m.label, v: 25 })));
  return [...details(r).matchAll(/<polyline[^>]*stroke="([^"]+)"/g)].map(m => m[1]);
}

function expectSurfaces(r: UsageReport, expected: string[]) {
  expect(ringColors(r)).toEqual(expected.slice(0, 3));
  expect(barColors(r)).toEqual(expected);
  expect(paceColors(r)).toEqual(expected);
  expect(historyColors(r)).toEqual(expected);
}

describe('active quota palette across gauge, card, pace and history', () => {
  it.each(['claude', 'codex:work'])('keeps period identity regardless of order for %s', id => {
    for (const meters of [
      [meter('Hours', hour), meter('Week', week)],
      [meter('Week', week), meter('Hours', hour)],
    ]) {
      expectSurfaces(report(meters, id), meters.map(m => palette(m.windowSeconds === week ? 1 : 2)));
    }
  });

  it.each([1, day - 1, day, 6 * day, 8 * day, 8 * day + 1, 30 * day])('respects the existing duration boundary %s', seconds => {
    const color = seconds < day ? 2 : seconds >= 6 * day && seconds <= 8 * day ? 1 : 3;
    // Deliberately conflicting label: duration takes precedence.
    expectSurfaces(report([meter('Semana', seconds)]), [palette(color)]);
  });

  it('recognizes legacy labels and other quotas without requiring a session/week pair', () => {
    for (const [label, windowSeconds, color] of [
      ['Sesión · 5 h', null, 2], ['Semana · todos', null, 1], ['Extra', null, 3],
      ['Sesión', 0, 2], ['Diario', day, 3],
    ] as const) {
      const r = report([meter(label, windowSeconds)]);
      expect(ringColors(r)).toEqual([palette(color)]);
      expect(barColors(r)).toEqual([palette(color)]);
      expect(historyColors(r)).toEqual([palette(color)]);
    }
  });

  it('colors every additional weekly quota and includes it in history', () => {
    const r = report([
      meter('Sesión', hour), meter('Semana · todos', week),
      meter('Semana · Sonnet', week), meter('Semana · Opus', week),
    ], 'claude');
    expectSurfaces(r, [2, 1, 1, 1].map(palette));
    const card = renderToStaticMarkup(<ProviderCard report={r} />);
    expect([...card.matchAll(/data-colored="true"/g)]).toHaveLength(4);
    expect([...card.matchAll(/class="eg-gauge__key/g)]).toHaveLength(4);
  });

  it.each(['nan', 'nan:work', 'nan_cloud', 'gemini', 'cursor', 'openrouter:work'])('retains ordinal colors for %s, also beyond three quotas', (id: string) => {
    const r = report([meter('A', hour), meter('B', week), meter('C', day), meter('D', hour)], id);
    expectSurfaces(r, [1, 2, 3, 1].map(palette));
    // Preserve main's compact behavior for model-based providers.
    r.meters[1].percent = 95;
    expect(ringColors(r, true)).toEqual([palette(1)]);
  });

  it('keeps API quotas ordinal even when they have period metadata', () => {
    expectSurfaces(report([meter('Budget', week)], 'openrouter', 'api'), [palette(1)]);
  });

  it('does not let unknown percentages shift the palette or create bars', () => {
    const r = report([meter('Unknown', week, null), meter('A', hour), meter('B', week)], 'nan');
    expectSurfaces(r, [1, 2].map(palette));
    const html = renderToStaticMarkup(<ProviderCard report={r} />);
    expect((html.match(/role="progressbar"/g) ?? [])).toHaveLength(2);
    expect(barColors(report([meter('Unknown', week, null)]))).toEqual([]);
    expect(ringColors(report([]))).toEqual([palette(1)]);
    expect(ringColors(report([meter('Unknown', week, null)]))).toEqual([palette(1)]);
  });

  it('preserves peak selection and the tiny-circle limit', () => {
    for (const [session, weekly, color] of [[95, 10, 2], [10, 95, 1]]) {
      const r = report([meter('Session', hour, session), meter('Week', week, weekly), meter('Extra', day)]);
      expect(ringColors(r, true)).toEqual([palette(color)]);
      expect(ringColors(r, false, 32)).toEqual([palette(2), palette(1)]);
    }
  });

  it('keeps warning, exhausted and muted states separate from consumption colors', () => {
    for (const [status, percent, state] of [
      ['ok', 95, 'warning'], ['ok', 105, 'over'], ['warning', 10, 'warning'], ['error', 105, 'muted'],
    ] as const) {
      const r = { ...report([meter('Session', hour, percent)]), status };
      expect(gauge(r)).toContain(`is-${state}`);
      expect(ringColors(r)).toEqual([palette(2)]);
      expect(barColors(r)).toEqual([palette(2)]);
    }
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2098-12-31T22:00:00Z'));
    const r = report([meter('Session', hour, 90)]);
    expect(details(r)).toContain('eg-notice--warning');
    expect(details(r)).toContain('antes del reinicio');
    expect(paceColors(r)).toEqual([palette(2)]);
    expect(renderToStaticMarkup(<ProviderCard report={report([meter('Week', week, 105)])} />)).toContain('data-level="max"');
  });

  it('uses the meter token in CSS without removing alarm styling', () => {
    expect(theme).toMatch(/\.q-meter\[data-colored\] \.eg-gauge__key\s*\{[^}]*background: var\(--meter-color\)/);
    expect(theme).toMatch(/\.q-meter \.eg-progress__bar\s*\{[^}]*background: var\(--meter-color/);
    expect(theme).toMatch(/\.eg-gauge\.is-over\s*\{[^}]*var\(--color-status-danger\)/);
    expect(theme).toContain(".q-panel .pace[data-status='over'] .pace__txt { color: var(--color-status-danger); }");
  });
});
