import detail from '../DetailPanel.tsx?raw';
import { describe, expect, it, vi } from 'vitest';

// Vitest stubs CSS imports; read the stylesheet rather than asserting against that stub.
const { readFileSync } = await vi.importActual<{ readFileSync(path: URL, encoding: string): string }>('node:fs');
const theme = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');

const rule = (selector: string) => {
  const start = theme.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing app rule: ${selector}`);
  const body = theme.indexOf('{', start) + 1;
  return theme.slice(body, theme.indexOf('}', body));
};

describe('consumption palette (#96)', () => {
  it('keeps exceeded halos semantic rather than replacing them with the user accent', () => {
    const over = rule('.eg-gauge.is-over');
    expect(over).toContain('var(--color-status-danger)');
    expect(over).not.toContain('var(--ring-1)');
  });

  it('preserves the selected palette for normal rings and bars across providers', () => {
    expect(rule('.eg-gauge__ring')).toContain('var(--ring-1)');
    for (const ring of [2, 3]) {
      expect(rule(`.eg-gauge__ring:nth-of-type(${ring})`)).toContain(`var(--ring-${ring})`);
    }
    for (const ring of [1, 2, 3]) {
      expect(rule(`.q-meter[data-ring='${ring}'] .eg-progress__bar`)).toContain(`var(--ring-${ring})`);
    }
    expect(theme).not.toMatch(/\.eg-gauge\.is-warning\s*\{/); // foundation's amber signal stays intact
  });
});

// Structural guards complement computed-style checks in the browser fixture.
describe('detail panel surface (#95)', () => {
  it('overrides clipped native-popup elevation while retaining its inset edge', () => {
    expect(rule('.q-panel')).toContain('box-shadow: var(--shadow-edge-strong);');
    expect(rule('.q-panel:hover, .q-panel.is-hover')).toContain('box-shadow: var(--shadow-edge-strong);');
  });

  it('rounds the painted bands using the outer frame rather than clipping content', () => {
    expect(rule('.q-panel > .q-card')).toMatch(/border-radius:\s*inherit/);
    const head = rule('.q-panel > .q-card > .eg-module-card__head');
    expect(head).toMatch(/border-top-left-radius:\s*inherit/);
    expect(head).toMatch(/border-top-right-radius:\s*inherit/);
    const foot = rule('.q-panel .panel__foot');
    expect(foot).toMatch(/border-bottom-left-radius:\s*inherit/);
    expect(foot).toMatch(/border-bottom-right-radius:\s*inherit/);
  });

  it('preserves focus effects and uncapped natural-height measurement', () => {
    expect(detail).toContain("overflow: 'visible'");
    for (const selector of ['.q-panel', '.q-panel > .q-card > .eg-module-card__head', '.q-panel .panel__foot']) {
      expect(rule(selector)).not.toMatch(/(?:height|max-height|clip-path)\s*:/);
    }
  });
});
