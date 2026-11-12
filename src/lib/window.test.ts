import { describe, expect, it } from 'vitest';
import { utcDay, windowEnd, windowStart } from './window';
import type { Meter } from './types';

/** Medidor con los dos datos de la ventana: el fin (`resetsAt`) y su duración. */
const meter = (resetsAt: string | null, windowSeconds: number | null): Meter => ({
  id: 'model:x',
  label: 'x',
  percent: 10,
  used: 1,
  limit: 10,
  unit: 'tokens',
  resetsAt,
  windowSeconds,
});

describe('window', () => {
  it('starts the window at the end minus the duration', () => {
    // El mes de la cuota publicada: 1-nov → 1-dic.
    const month = meter('2026-12-01T00:00:00Z', 2_592_000);
    expect(windowEnd(month)).toBe(Date.parse('2026-12-01T00:00:00Z'));
    expect(windowStart(month)).toBe(Date.parse('2026-11-01T00:00:00Z'));
    // La ventana de 5 h: el inicio es cinco horas antes del fin.
    const session = meter('2026-12-05T22:15:31Z', 18_000);
    expect(windowEnd(session)).toBe(Date.parse('2026-12-05T22:15:31Z'));
    expect(windowStart(session)).toBe(Date.parse('2026-12-05T17:15:31Z'));
  });

  it('has no window without the end or the duration', () => {
    expect(windowEnd(meter(null, 100))).toBeNull();
    expect(windowEnd(meter('no es una fecha', 100))).toBeNull();
    expect(windowStart(meter('2026-12-01T00:00:00Z', null))).toBeNull();
    expect(windowStart(meter(null, 100))).toBeNull();
  });

  it('compares windows by UTC day, not by instant', () => {
    // Dos ventanas que difieren en horas pero no en días son el mismo día UTC.
    const midnight = windowStart(meter('2026-12-05T00:00:00Z', 2_592_000))!;
    const evening = windowStart(meter('2026-12-05T22:15:31Z', 2_592_000))!;
    expect(utcDay(midnight)).toBe(utcDay(evening));
    // Una ventana que empieza al día siguiente es otro día.
    const nextDay = windowStart(meter('2026-12-06T00:00:00Z', 2_592_000))!;
    expect(utcDay(nextDay)).toBe(utcDay(evening) + 1);
  });
});
