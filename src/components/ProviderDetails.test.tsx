import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderDetails } from './ProviderDetails';
import { ProviderCard } from './ProviderCard';
import { ProviderGauge } from './ProviderGauge';
import { MeterBar } from './MeterBar';
import type { Meter, Sample, UsageReport } from '../lib/types';

const { readFileSync } = await vi.importActual<{ readFileSync(path: URL, encoding: string): string }>('node:fs');
const theme = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');

const report: UsageReport = {
  id: 'claude:extra', name: 'Claude · Trabajo', kind: 'subscription', status: 'ok', plan: null,
  meters: [], spend: null, message: null, action: null, fetchedAt: '2026-10-17T00:00:00Z',
  daily: [{ date: '2026-10-15', value: 10 }, { date: '2026-10-16', value: 20 }],
};

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
  vi.unstubAllGlobals();
});

describe('provider detail sections', () => {
  describe.each([
    ['card', ProviderCard],
    ['details', ProviderDetails],
  ] as const)('%s popup period identity', (_name, Component) => {
    it.each([
      [18000, 604800, 604800],
      [604800, 18000],
    ])('uses popup colors without mutating ring tokens for window order %j', (...windows) => {
      const html = renderToStaticMarkup(<Component report={{
        ...report,
        meters: windows.map((windowSeconds, i) => ({
          id: '', label: `Limit ${i + 1}`, percent: 20, used: null, limit: null, unit: null,
          windowSeconds, resetsAt: new Date(Date.now() + windowSeconds * 500).toISOString(),
        })),
      }} />);
      expect(html).not.toMatch(/style="[^"]*--ring-[123]:/);
      const colors = [...html.matchAll(/(?:--meter-color:|background:)([^;\"]+)/g)].map(m => m[1]);
      expect(colors).toEqual(windows.map(seconds => seconds < 86400 ? '#ffffff' : 'var(--popup-primary, #ff0036)'));
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
      id: '', label: 'Semana', percent: 99, used: null, limit: null, unit: null,
      windowSeconds: 604800, resetsAt: new Date(Date.now() + 302400000).toISOString(),
    }] }} />);
    expect(html).toContain('A este ritmo');
    expect(html.indexOf('role="status"')).toBeLessThan(html.indexOf('<details'));
  });
});

describe('stale meters (per-meter mark)', () => {
  const meter = (stale?: boolean) => ({
    id: 'weekly', label: 'Semana · todos', percent: 95, used: null, limit: null, unit: null,
    resetsAt: null, windowSeconds: null, stale,
  });

  it('shows the cached chip on the stale meter only', () => {
    const stale = renderToStaticMarkup(<MeterBar meter={meter(true)} ring={null} />);
    const fresh = renderToStaticMarkup(<MeterBar meter={meter()} ring={null} />);
    // El medidor viejo lleva la pastilla de «caché» (misma marca y title que la del informe).
    expect(stale).toContain('caché');
    expect(stale).toContain('Datos del último ciclo correcto');
    // El fresco no lleva ninguna marca.
    expect(fresh).not.toContain('caché');
    expect(fresh).not.toContain('Datos del último ciclo correcto');
  });

  it('dims the progress bar of the stale meter', () => {
    const stale = renderToStaticMarkup(<MeterBar meter={meter(true)} ring={null} />);
    const fresh = renderToStaticMarkup(<MeterBar meter={meter()} ring={null} />);
    // La atenuación va por clase (el tema la define), no por estilo en línea.
    expect(stale).toContain('q-meter--stale');
    expect(stale).toContain('q-meter__stale');
    expect(fresh).not.toContain('q-meter--stale');
    expect(fresh).not.toContain('q-meter__stale');
  });
});

// T31 (S33 caso 3, S34): la presentación del dato obsoleto. O4+O3: lo viejo no
// participa del estado actual, pero se sigue viendo, atenuado y con su fecha.
describe('stale data presentation (T31)', () => {
  const staleMeter = (over: Partial<Meter> = {}): Meter => ({
    id: 'weekly', label: 'Semana · todos', percent: 100, used: null, limit: null, unit: null,
    resetsAt: null, windowSeconds: null, stale: true, ...over,
  });
  const freshMeter = (over: Partial<Meter> = {}): Meter => ({
    id: 'budget', label: 'Presupuesto mensual', percent: 20, used: null, limit: null, unit: null,
    resetsAt: null, windowSeconds: null, ...over,
  });

  it('shows the orb as muted with its reason when there is no current reading (C1)', () => {
    const onlyOld: UsageReport = { ...report, status: 'warning', meters: [staleMeter()] };
    const html = renderToStaticMarkup(
      <ProviderGauge report={onlyOld} small={false} size={60} active={false} onHover={() => {}} />,
    );
    // Sin lectura vigente el orbe no se pinta como el estado de ahora…
    expect(html).toContain('is-muted');
    expect(html).not.toContain('is-over');
    expect(html).not.toContain('is-warning');
    // …y el motivo accesible lo dice.
    expect(html).toMatch(/aria-label="[^"]*Sin lectura actual/);
  });

  it('shows the orb as muted when the whole report is stale (C1)', () => {
    // Informe entero conservado: sus medidores no van marcados, pero el informe sí.
    const whole: UsageReport = { ...report, status: 'warning', stale: true, meters: [staleMeter({ stale: undefined })] };
    const html = renderToStaticMarkup(
      <ProviderGauge report={whole} small={false} size={60} active={false} onHover={() => {}} />,
    );
    expect(html).toContain('is-muted');
    expect(html).not.toContain('is-over');
    expect(html).not.toContain('is-warning');
  });

  it('gives the current meter the first ring and the stale one none (C2)', () => {
    const mixed: UsageReport = { ...report, meters: [staleMeter({ percent: 95 }), freshMeter()] };
    const html = renderToStaticMarkup(<ProviderCard report={mixed} />);
    // El medidor vigente es el anillo 1: el viejo no ocupa lugar en la leyenda.
    expect(html).toContain('data-ring="1"');
    expect(html).not.toContain('data-ring="2"');
    expect(html.match(/class="eg-gauge__key/g)).toHaveLength(1);
  });

  it('shows the date of the last reading next to the cached chip (C4)', () => {
    const meter = { ...staleMeter(), readAt: '2026-11-12T08:00:00Z' };
    const html = renderToStaticMarkup(<MeterBar meter={meter} ring={null} locale="es" />);
    expect(html).toContain('caché');
    expect(html).toContain('12 nov');
    const en = renderToStaticMarkup(<MeterBar meter={meter} ring={null} locale="en" />);
    expect(en).toContain('cached');
    expect(en).toContain('Nov 12');
  });

  it('dims the whole stale meter and drops the exceeded-limit mark (R5)', () => {
    const stale = renderToStaticMarkup(<MeterBar meter={staleMeter({ percent: 95 })} ring={null} />);
    const fresh = renderToStaticMarkup(<MeterBar meter={freshMeter({ percent: 95 })} ring={null} />);
    expect(stale).toContain('data-stale="true"');
    expect(fresh).not.toContain('data-stale');
    // El tema atenúa el componente entero y su número deja de llevar la marca de «tope superado».
    expect(theme).toMatch(/\.q-meter--stale\[data-level='max'\] \.q-meter__value \{[^}]*color: var\(--color-fg-muted\)/);
    expect(theme).toMatch(/\.q-meter--stale \.q-meter__meta \{[^}]*opacity: 0\.75/);
  });

  it('keeps the history of the stale meter but gives it no pace (R2, R3)', () => {
    const window = { resetsAt: new Date(Date.now() + 302400000).toISOString(), windowSeconds: 604800 };
    const mixed: UsageReport = {
      ...report,
      meters: [staleMeter({ ...window, percent: 99 }), freshMeter({ ...window })],
    };
    history.samples = [
      { t: 1, p: report.id, l: 'Semana · todos', v: 95 },
      { t: 2, p: report.id, l: 'Semana · todos', v: 96 },
      { t: 1, p: report.id, l: 'Presupuesto mensual', v: 20 },
      { t: 2, p: report.id, l: 'Presupuesto mensual', v: 21 },
    ];
    const html = renderToStaticMarkup(<ProviderDetails report={mixed} />);
    // La serie del medidor viejo no se borra: la historia es información real.
    expect(html.match(/<polyline/g)).toHaveLength(2);
    // Pero no genera ritmo ni el aviso «a este ritmo».
    expect(html.match(/class="pace"/g)).toHaveLength(1);
    expect(html).not.toContain('A este ritmo');
  });
});
