import { describe, expect, it } from 'vitest';
import { settleTextScale, textScale, toCss, toMonitor, TEXT_SCALE_MAX, TEXT_SCALE_MIN } from './text-scale';

describe('text scale (#228)', () => {
  it('is the WebView ratio over the monitor scale of the same window', () => {
    expect(textScale(1.0812, 1.02)).toBe(1.06);
    expect(textScale(1.25, 1)).toBe(1.25);
    expect(textScale(1.875, 1.25)).toBe(1.5);
    expect(textScale(3.375, 1.5)).toBe(2.25);
  });

  it('is exactly 1 when the WebView ratio equals the monitor scale', () => {
    for (const sf of [1, 1.25, 1.5, 2]) expect(textScale(sf, sf)).toBe(1);
  });

  it('rounds float noise to four decimals so it never triggers a re-placement', () => {
    expect(textScale(1.1 * 1.3, 1.1)).toBe(1.3);
    expect(textScale(1.000049, 1)).toBe(1);
  });

  it('falls back to 1 for non-finite or non-positive inputs', () => {
    for (const [dpr, sf] of [[0, 1], [1, 0], [-1.25, 1], [1.25, -1], [NaN, 1], [1, NaN], [Infinity, 1], [1, Infinity]]) {
      expect(textScale(dpr, sf)).toBe(1);
    }
  });

  it('converts CSS px to monitor units and back', () => {
    expect(toMonitor(330, 1.06)).toBeCloseTo(349.8, 10);
    expect(toCss(toMonitor(330, 1.06), 1.06)).toBeCloseTo(330, 10);
    expect(toMonitor(330, 1)).toBe(330);
    expect(toCss(-24, 1)).toBe(-24);
  });
});

describe('settled text scale (#228, S4)', () => {
  it('accepts a consistent sample inside the Windows range', () => {
    expect(settleTextScale(1, { dprBefore: 1.0812, sf: 1.02, dprAfter: 1.0812 })).toBe(1.06);
    expect(settleTextScale(1.06, { dprBefore: 1.25, sf: 1.25, dprAfter: 1.25 })).toBe(1);
  });

  it('keeps the last valid value when the WebView ratio moved while the monitor scale was read', () => {
    expect(settleTextScale(1.06, { dprBefore: 1.0812, sf: 1.5, dprAfter: 1.59 })).toBe(1.06);
  });

  it('keeps the last valid value outside the 100-225 % range Windows allows', () => {
    expect(TEXT_SCALE_MIN).toBe(1);
    expect(TEXT_SCALE_MAX).toBe(2.25);
    // Monitor A ratio read with monitor B scale: a transient mix, not a text size.
    expect(settleTextScale(1.06, { dprBefore: 1.0812, sf: 1.5, dprAfter: 1.0812 })).toBe(1.06);
    expect(settleTextScale(1.06, { dprBefore: 3.6, sf: 1.5, dprAfter: 3.6 })).toBe(1.06);
    expect(settleTextScale(1.5, { dprBefore: 2.25, sf: 1, dprAfter: 2.25 })).toBe(2.25);
  });

  it('keeps the last valid value for unreadable samples', () => {
    expect(settleTextScale(1.06, { dprBefore: NaN, sf: 1, dprAfter: NaN })).toBe(1.06);
    expect(settleTextScale(1.06, { dprBefore: 1, sf: 0, dprAfter: 1 })).toBe(1.06);
  });
});
