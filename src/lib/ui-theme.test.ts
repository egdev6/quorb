import detail from '../DetailPanel.tsx?raw';
import { describe, expect, it, vi } from 'vitest';

// Vitest stubs CSS imports; read the stylesheet rather than asserting against that stub.
const { readFileSync } = await vi.importActual<{ readFileSync(path: URL, encoding: string): string }>('node:fs');
const theme = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');

const rule = (selector: string) => {
  const start = theme.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`Missing app rule: ${selector}`);
  const body = theme.indexOf('{', start) + 1;
  return theme.slice(body, theme.indexOf('}', body));
};

describe('compact banked reset placement', () => {
  it('anchors the white reset count at bottom-right without overriding the shared reset color', () => {
    const reset = rule(".q-validity--compact[data-kind='resets']");
    for (const declaration of ['top: auto;', 'left: auto;', 'right: -2px;', 'bottom: -2px;']) {
      expect(reset).toContain(declaration);
    }
    expect(reset).not.toMatch(/\bcolor\s*:/);
    expect(rule(".q-validity[data-kind='resets']").trim()).toBe('color: var(--color-primitive-white);');
    expect(rule('.q-validity')).toContain('color: var(--color-primitive-red-200);');
  });

  it('bounds only compact reset icons while preserving the expanded icon size', () => {
    const icon = rule(".q-validity--compact[data-kind='resets'] svg");
    expect(icon).toContain('width: clamp(9px, calc(var(--size) * 0.18), 12px);');
    expect(icon).toContain('height: clamp(9px, calc(var(--size) * 0.18), 12px);');
    expect(icon).toContain('flex: none;');
    expect(icon).not.toContain('100%');
    expect(rule('.q-validity svg')).toContain('width: 14px; height: 14px;');
    expect(rule('.q-validity svg')).toContain('stroke: currentColor;');
  });

  it('always anchors account numbers at top-right, even without reset credits', () => {
    const account = rule('.orb__acct');
    for (const declaration of ['right: -2px;', 'top: -2px;', 'bottom: auto;']) {
      expect(account).toContain(declaration);
    }
    expect(theme).not.toContain(".orb > .q-validity--compact[data-kind='resets'] ~ .orb__acct");
  });

  it('gives account numbers and compact resets one shared chip style', () => {
    const shared = rule(".orb__acct, .q-validity--compact[data-kind='resets']");
    for (const declaration of [
      'background: var(--color-surface-2);', 'border: 1px solid var(--color-border-hairline-strong);',
      'color: var(--color-primitive-white);', 'border-radius: 6px;',
      'height: clamp(14px, calc(var(--size) * 0.3), 22px);',
      'font-size: clamp(8px, calc(var(--size) * 0.18), 11px);', 'font-weight: 700;',
      'padding: 1px 2px;', 'box-shadow: var(--shadow-edge);',
    ]) expect(shared).toContain(declaration);
    expect(rule('.orb__acct')).not.toMatch(/\b(?:background|border|font|font-size|height|padding)\s*:/);
  });
});

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

describe('settings disclosures', () => {
  it('replaces native markers with a right-aligned chevron that rotates when open', () => {
    const summary = rule('.q-details summary');
    expect(summary).toContain('display: flex;');
    expect(summary).toContain('align-items: center;');
    expect(summary).toContain('justify-content: space-between;');
    expect(summary).toContain('gap: 12px;');
    expect(summary).toContain('list-style: none;');
    expect(rule('.q-details summary::-webkit-details-marker')).toContain('display: none;');
    const chevron = rule('.q-details summary::after');
    expect(chevron).toContain("content: '';");
    expect(chevron).toContain('width: 8px;');
    expect(chevron).toContain('height: 8px;');
    expect(chevron).toContain('flex: none;');
    expect(chevron).toContain('border-right: 2px solid currentColor;');
    expect(chevron).toContain('border-bottom: 2px solid currentColor;');
    expect(chevron).toContain('transform: rotate(45deg);');
    expect(chevron).toContain('transition: transform 200ms ease;');
    expect(rule('.q-details[open] > summary::after')).toContain('transform: rotate(225deg);');
  });

  it('provides hover feedback and a visible keyboard focus outline', () => {
    expect(rule('.q-details summary:hover')).toContain('color: var(--color-fg-default);');
    const focus = rule('.q-details summary:focus-visible');
    expect(focus).toContain('outline: 2px solid var(--color-fg-brand-hover);');
    expect(focus).toContain('outline-offset: 4px;');
  });

  it('disables chevron animation under reduced motion', () => {
    expect(theme).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.q-details summary::after\s*\{\s*transition:\s*none;\s*\}\s*\}/,
    );
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
