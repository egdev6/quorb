import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderGauge } from './ProviderGauge';
import type { Meter, UsageReport } from '../lib/types';

const meter = (label: string, windowSeconds: number | null, percent: number | null = 20): Meter => ({
  id: '', label, windowSeconds, percent, used: null, limit: null, unit: null, resetsAt: null,
});
function colors(meters: Meter[], small = false, size = 60, id = 'claude') {
  const report: UsageReport = {
    id, name: id, kind: 'subscription', status: 'ok', plan: null,
    meters, spend: null, message: null, action: null, fetchedAt: '',
  };
  const html = renderToStaticMarkup(<ProviderGauge report={report} small={small} size={size} active={false} onHover={() => {}} />);
  return [...html.matchAll(/class="eg-gauge__ring" style="([^"]*)"/g)]
    .map((match) => match[1].match(/--c:([^;]+)/)?.[1]);
}

afterEach(() => vi.unstubAllGlobals());

describe('ProviderGauge popup focus', () => {
  function gauge(userAgent: string, focusVisible: boolean) {
    vi.stubGlobal('navigator', { userAgent });
    const onHover = vi.fn();
    const report: UsageReport = {
      id: 'claude', name: 'Claude', kind: 'subscription', status: 'ok', plan: null,
      meters: [], spend: null, message: null, action: null, fetchedAt: '',
    };
    const button = ProviderGauge({ report, small: false, size: 60, active: false, onHover });
    const target = { matches: vi.fn(() => focusVisible) };
    const event = { currentTarget: target };
    return { button, target, event, onHover };
  }

  it('does not reopen on repeated incidental Windows focus after the pointer left', () => {
    const { button, target, event, onHover } = gauge('Windows NT 10.0', false);
    button.props.onMouseEnter(event);
    expect(onHover).toHaveBeenCalledWith(target);
    onHover.mockClear(); // The native presence tracker has closed the popup.
    for (let i = 0; i < 5; i++) button.props.onFocus(event);
    expect(onHover).not.toHaveBeenCalled();
  });

  it('still opens on Windows keyboard focus and click', () => {
    const keyboard = gauge('Windows NT 10.0', true);
    keyboard.button.props.onFocus(keyboard.event);
    expect(keyboard.onHover).toHaveBeenCalledWith(keyboard.target);
    expect(keyboard.target.matches).toHaveBeenCalledWith(':focus-visible');
    const pointer = gauge('Windows NT 10.0', false);
    pointer.button.props.onClick(pointer.event);
    expect(pointer.onHover).toHaveBeenCalledWith(pointer.target);
  });

  it.each(['Macintosh; Intel Mac OS X', 'X11; Linux x86_64'])(
    'leaves all focus opening behavior unchanged on %s', (userAgent) => {
      for (const focusVisible of [false, true]) {
        const { button, event, onHover, target } = gauge(userAgent, focusVisible);
        button.props.onFocus(event);
        expect(onHover).toHaveBeenCalledWith(target);
        expect(target.matches).not.toHaveBeenCalled();
      }
    },
  );
});

describe('ProviderGauge semantic colors', () => {
  it.each(['nan', 'nan:work', 'gemini', 'cursor', 'copilot', 'openrouter'])('keeps one configured color per ring for %s', (id) => {
    const meters = [meter('Modelo A', 2592000), meter('Modelo B', null), meter('Modelo C', 86400)];
    expect(colors(meters, false, 60, id)).toEqual(['var(--ring-1)', 'var(--ring-2)', 'var(--ring-3)']);
    expect(colors(meters, true, 60, id)).toEqual(['var(--ring-1)']);
  });
  it.each(['claude:work', 'codex', 'codex:work'])('retains semantic colors for session-based accounts %s', (id) => {
    expect(colors([meter('Sesión', 18000), meter('Semana', 604800)], false, 60, id))
      .toEqual(['var(--ring-2)', 'var(--ring-1)']);
  });
  it('uses configured weekly, hourly and other colors instead of ring positions', () => {
    expect(colors([meter('Sesión · 5 h', 18000), meter('Semana', 604800), meter('Mes', 2592000)]))
      .toEqual(['var(--ring-2)', 'var(--ring-1)', 'var(--ring-3)']);
  });
  it('does not change color when provider order changes or a meter is missing', () => {
    expect(colors([meter('Semana', 604800), meter('Sesión', 18000)]))
      .toEqual(['var(--ring-1)', 'var(--ring-2)']);
    expect(colors([meter('Diario', 86400)])).toEqual(['var(--ring-3)']);
  });
  it('keeps the peak meter category in compact mode', () => {
    expect(colors([meter('Semana', 604800, 10), meter('Sesión', 18000, 90)], true))
      .toEqual(['var(--ring-2)']);
    expect(colors([meter('Semana', 604800, 90), meter('Sesión', 18000, 10)], true))
      .toEqual(['var(--ring-1)']);
  });
  it('recognizes legacy labels without durations', () => {
    expect(colors([meter('Sesión · 5 h', null), meter('Semana · todos', null), meter('Uso extra (mes)', null)]))
      .toEqual(['var(--ring-2)', 'var(--ring-1)', 'var(--ring-3)']);
  });
  it('uses duration metadata even with unrelated labels', () => {
    expect(colors([meter('Quota A', 604800), meter('Quota B', 14400), meter('Quota C', null)]))
      .toEqual(['var(--ring-1)', 'var(--ring-2)', 'var(--ring-3)']);
  });
  it('filters unknown percentages, limits small circles, and renders a fallback', () => {
    expect(colors([meter('Semana', 604800, null), meter('Sesión', 18000), meter('Mes', 2592000)], false, 32))
      .toEqual(['var(--ring-2)', 'var(--ring-3)']);
    expect(colors([])).toEqual(['var(--ring-1)']);
  });
});
