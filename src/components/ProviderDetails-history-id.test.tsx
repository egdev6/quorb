import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meter, Sample, UsageReport } from '../lib/types';
import { ProviderDetails } from './ProviderDetails';

// SSR does not run effects: seed the history state without a DOM or Tauri calls.
const history = vi.hoisted(() => ({ samples: null as Sample[] | null }));
vi.mock('react', async (importOriginal) => {
  const react = (await importOriginal()) as typeof import('react');
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
});

const meter: Meter = {
  id: 'session',
  label: 'Session · 5 h',
  percent: 40,
  used: null,
  limit: null,
  unit: null,
  resetsAt: null,
  windowSeconds: 18000,
};
const report = (over: Partial<UsageReport> = {}): UsageReport => ({
  id: 'claude',
  name: 'Claude',
  kind: 'subscription',
  status: 'ok',
  plan: null,
  meters: [meter],
  spend: null,
  message: null,
  action: null,
  fetchedAt: '2026-10-20T00:00:00Z',
  ...over,
});
const sample = (l: string, t: number, v: number): Sample => ({ t, p: 'claude', l, v });
/** Number of (x,y) pairs drawn by each history polyline. */
const polylinePoints = (r: UsageReport) =>
  [...renderToStaticMarkup(<ProviderDetails report={r} />).matchAll(/<polyline[^>]*points="([^"]*)"/g)].map((m) => m[1].trim().split(/\s+/).length);

describe('ProviderDetails history matching', () => {
  it('matches samples by the stable meter id even when the label changed', () => {
    history.samples = [sample('session', 1, 10), sample('session', 2, 20)];
    expect(polylinePoints(report())).toEqual([2]);
  });

  it('still matches legacy samples stored by label', () => {
    history.samples = [sample('Session · 5 h', 1, 10), sample('Session · 5 h', 2, 20)];
    expect(polylinePoints(report())).toEqual([2]);
  });

  it('joins legacy label samples and new id samples into one series', () => {
    history.samples = [sample('Session · 5 h', 1, 10), sample('session', 2, 20), sample('session', 3, 30)];
    expect(polylinePoints(report())).toEqual([3]);
  });

  it('ignores samples of other meters', () => {
    history.samples = [sample('weekly', 1, 10), sample('weekly', 2, 20)];
    expect(polylinePoints(report())).toEqual([]);
  });

  it('keeps the spend sentinel working', () => {
    history.samples = [sample('spend', 1, 1), sample('spend', 2, 2)];
    const withSpend = report({ meters: [], spend: { amount: 2, currency: 'USD', periodLabel: 'Este mes', budget: null } });
    expect(polylinePoints(withSpend)).toEqual([2]);
  });

  it('falls back to the label for meters without an id', () => {
    history.samples = [sample('Session · 5 h', 1, 10), sample('Session · 5 h', 2, 20)];
    expect(polylinePoints(report({ meters: [{ ...meter, id: '' }] }))).toEqual([2]);
  });
});
