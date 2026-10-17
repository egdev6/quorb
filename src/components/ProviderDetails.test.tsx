import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderDetails } from './ProviderDetails';
import { ProviderCard } from './ProviderCard';
import type { UsageReport } from '../lib/types';

const report: UsageReport = {
  id: 'claude:extra', name: 'Claude · Trabajo', kind: 'subscription', status: 'ok', plan: null,
  meters: [], spend: null, message: null, action: null, fetchedAt: '2026-10-17T00:00:00Z',
  daily: [{ date: '2026-10-15', value: 10 }, { date: '2026-10-16', value: 20 }],
};

afterEach(() => vi.unstubAllGlobals());

describe('provider detail sections', () => {
  describe.each([
    ['card', ProviderCard],
    ['details', ProviderDetails],
  ] as const)('%s palette independence', (_name, Component) => {
    it.each([
      [18000, 604800, 604800],
      [604800, 18000],
    ])('inherits ring colors for window order %j', (...windows) => {
      const html = renderToStaticMarkup(<Component report={{
        ...report,
        meters: windows.map((windowSeconds, i) => ({
          label: `Limit ${i + 1}`, percent: 20, used: null, limit: null, unit: null,
          windowSeconds, resetsAt: new Date(Date.now() + windowSeconds * 500).toISOString(),
        })),
      }} />);
      expect(html).not.toMatch(/style="[^"]*--ring-[123]:/);
      expect(html).not.toContain('#ffffff');
      expect(html).not.toContain('--popup-primary');
    });
  });

  it.each([
    { pace: false, history: true },
    { pace: true, history: true },
    { pace: false, history: false },
  ])('restores independent disclosures for the report account: %j', ({ pace, history }) => {
    const getItem = vi.fn((key: string) => ({
      [`popup:${report.id}:pace`]: String(pace),
      [`popup:${report.id}:history`]: String(history),
    })[key] ?? null);
    vi.stubGlobal('localStorage', { getItem });

    const html = renderToStaticMarkup(<ProviderDetails report={report} />);
    const sections = html.match(/<details\b[^>]*>/g);
    expect(sections).toHaveLength(2);
    expect(sections?.[0].includes('open=""')).toBe(pace);
    expect(sections?.[1].includes('open=""')).toBe(history);
    expect(getItem).toHaveBeenCalledWith(`popup:${report.id}:pace`);
    expect(getItem).toHaveBeenCalledWith(`popup:${report.id}:history`);
  });

  it('renders pace expanded and history collapsed by default', () => {
    const html = renderToStaticMarkup(<ProviderDetails report={report} />);
    expect(html.match(/<details\b/g)).toHaveLength(2);
    expect(html.match(/<details[^>]* open=""/g)).toHaveLength(1);
    expect(html).toMatch(/<summary[^>]*>.*Ritmo de consumo.*<\/summary>/);
    expect(html).toMatch(/<summary[^>]*>.*Historial.*<\/summary>/);
    expect(html).not.toMatch(/<details[^>]* name=/);
  });

  it('keeps daily token charts within the collapsible history', () => {
    const html = renderToStaticMarkup(<ProviderDetails report={report} />);
    const history = html.slice(html.indexOf('Historial'));
    expect(history).toContain('Tokens por día');
    expect(history.indexOf('Tokens por día')).toBeLessThan(history.indexOf('</details>'));
  });

  it('keeps the risk notice outside both disclosures', () => {
    const html = renderToStaticMarkup(<ProviderDetails report={{ ...report, meters: [{
      label: 'Semana', percent: 99, used: null, limit: null, unit: null,
      windowSeconds: 604800, resetsAt: new Date(Date.now() + 302400000).toISOString(),
    }] }} />);
    expect(html).toContain('A este ritmo');
    expect(html.indexOf('role="status"')).toBeLessThan(html.indexOf('<details'));
  });
});
