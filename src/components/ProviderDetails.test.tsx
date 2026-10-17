import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderDetails } from './ProviderDetails';
import type { UsageReport } from '../lib/types';

const report: UsageReport = {
  id: 'claude:extra', name: 'Claude · Trabajo', kind: 'subscription', status: 'ok', plan: null,
  meters: [], spend: null, message: null, action: null, fetchedAt: '2026-10-17T00:00:00Z',
  daily: [{ date: '2026-10-15', value: 10 }, { date: '2026-10-16', value: 20 }],
};

describe('provider detail sections', () => {
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
