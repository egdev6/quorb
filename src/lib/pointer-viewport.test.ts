import { describe, expect, it } from 'vitest';

import { pointerInsideViewport } from './pointer-viewport';

describe('pointerInsideViewport', () => {
  it('accepts a point inside the viewport', () => {
    expect(pointerInsideViewport(10, 20, 100, 50)).toBe(true);
  });

  it('accepts the top-left border and rejects one pixel before it', () => {
    expect(pointerInsideViewport(0, 0, 100, 50)).toBe(true);
    expect(pointerInsideViewport(-1, 0, 100, 50)).toBe(false);
    expect(pointerInsideViewport(0, -1, 100, 50)).toBe(false);
  });

  it('accepts the last pixel inside the viewport and rejects the first one past it', () => {
    expect(pointerInsideViewport(99, 49, 100, 50)).toBe(true);
    expect(pointerInsideViewport(100, 49, 100, 50)).toBe(false);
    expect(pointerInsideViewport(99, 50, 100, 50)).toBe(false);
  });

  it('rejects a point outside the viewport', () => {
    expect(pointerInsideViewport(150, 20, 100, 50)).toBe(false);
    expect(pointerInsideViewport(10, 80, 100, 50)).toBe(false);
  });
});
