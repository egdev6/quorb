import overlay from '../Overlay.tsx?raw';
import { describe, expect, it } from 'vitest';
import { confettiVelocity, CORNER_HORIZONTAL_GAIN } from './confetti-motion';

describe('confetti corner reach', () => {
  it.each([-Math.PI / 3, (-2 * Math.PI) / 3])('doubles lateral distance without changing the vertical path for angle %s', (angle) => {
    for (const speed of [9, 14, 19]) for (const spread of [-0.45, 0, 0.45]) {
      const baseline = { x: 0, y: 0, ...confettiVelocity(angle + spread, speed) };
      const boosted = { x: 0, y: 0, ...confettiVelocity(angle + spread, speed, CORNER_HORIZONTAL_GAIN) };
      for (let frame = 0; frame < 252; frame++) {
        for (const p of [baseline, boosted]) {
          p.vy = (p.vy + 0.32) * 0.99;
          p.vx *= 0.99;
          p.x += p.vx;
          p.y += p.vy;
        }
        expect(boosted.x).toBeCloseTo(baseline.x * 2, 9);
        expect(boosted.y).toBe(baseline.y);
      }
      expect(Math.sign(boosted.x)).toBe(angle > -Math.PI / 2 ? 1 : -1);
    }
  });

  it('keeps top rain at its original horizontal and vertical velocity', () => {
    for (const spread of [-0.45, 0, 0.45]) {
      const angle = Math.PI / 2 + spread;
      expect(confettiVelocity(angle, 14)).toEqual({ vx: Math.cos(angle) * 14, vy: Math.sin(angle) * 14 });
    }
  });
  it('boosts only the two bottom cannons, preserving the top rain and timing', () => {
    expect(overlay).toContain('burst(0, H, -Math.PI / 3, 120, CORNER_HORIZONTAL_GAIN)');
    expect(overlay).toContain('burst(W, H, (-2 * Math.PI) / 3, 120, CORNER_HORIZONTAL_GAIN)');
    expect(overlay).toContain('burst(rnd(0, W), -20, Math.PI / 2, 1)');
    expect(overlay).toContain('const DURATION = 4200;');
    expect(overlay).toContain('p.vy += 0.32;');
  });
});
