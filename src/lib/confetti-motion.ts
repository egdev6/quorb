/** More horizontal reach from the bottom corners, without changing lift or rain. */
export const CORNER_HORIZONTAL_GAIN = 2;

export function confettiVelocity(angle: number, speed: number, horizontalGain = 1): { vx: number; vy: number } {
  return { vx: Math.cos(angle) * speed * horizontalGain, vy: Math.sin(angle) * speed };
}
