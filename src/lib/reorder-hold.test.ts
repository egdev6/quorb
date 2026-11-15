import { describe, expect, it } from 'vitest';
import { holdOnDrop, NO_HOLD, onOrbEnter, onOrbLeave, orbIdAtPoint } from './reorder-hold';

describe('the reorder hold covers one orb (#264/S23, S28)', () => {
  it('starts with the dragged orb', () => {
    expect(holdOnDrop('a', null)).toEqual({ orbIds: ['a'], confirmed: false });
  });

  it('covers the orb under the pointer too, when it is another one', () => {
    expect(holdOnDrop('a', 'b')).toEqual({ orbIds: ['a', 'b'], confirmed: false });
  });

  it('does not repeat the orb when both signals name it', () => {
    expect(holdOnDrop('a', 'a')).toEqual({ orbIds: ['a'], confirmed: false });
  });

  it('blocks the held orb', () => {
    const entered = onOrbEnter(holdOnDrop('a', null), 'a');
    expect(entered.blocked).toBe(true);
    expect(entered.hold.confirmed).toBe(true);
  });

  it('lets the other orbs open', () => {
    expect(onOrbEnter(holdOnDrop('a', null), 'b').blocked).toBe(false);
  });

  it('ends the hold when the pointer enters another orb, once it was confirmed', () => {
    const hold = { orbIds: ['a'], confirmed: true };
    const entered = onOrbEnter(hold, 'b');
    expect(entered.hold).toEqual(NO_HOLD);
    expect(entered.blocked).toBe(false);
  });

  it('keeps the hold when another orb is entered before the pointer reaches the held one', () => {
    // El salto de layout del soltar puede poner otro orbe bajo el puntero: esa
    // entrada no disuelve el bloqueo, porque todavía no se vio al puntero
    // sobre el orbe bloqueado (#264/S28).
    const hold = holdOnDrop('a', null);
    const entered = onOrbEnter(hold, 'b');
    expect(entered.hold).toEqual(hold);
    expect(entered.blocked).toBe(false);
  });

  it('ends the hold when the pointer leaves the held orb', () => {
    expect(onOrbLeave({ orbIds: ['a'], confirmed: true }, 'a')).toEqual(NO_HOLD);
  });

  it('keeps the hold when the layout moves the held orb before the pointer reaches it', () => {
    // El salto de layout del soltar saca al orbe de debajo del puntero y
    // dispara su salida: si esa salida disolviera el bloqueo, el `enter`
    // diferido abriría el detalle solo sobre el orbe soltado (#222).
    const hold = holdOnDrop('a', null);
    expect(onOrbLeave(hold, 'a')).toEqual(hold);
  });

  it('keeps the hold when the pointer leaves another orb', () => {
    expect(onOrbLeave({ orbIds: ['a'], confirmed: true }, 'b')).toEqual({ orbIds: ['a'], confirmed: true });
  });

  it('blocks nothing without a hold', () => {
    expect(onOrbEnter(NO_HOLD, 'a')).toEqual({ hold: NO_HOLD, blocked: false });
  });
});

describe('the orb under the pointer (#264/S23)', () => {
  it('reads the orb of the element at the point', () => {
    const doc = { elementFromPoint: () => ({ closest: () => ({ getAttribute: () => 'a' }) }) };
    expect(orbIdAtPoint(10, 20, doc)).toBe('a');
  });

  it('is null when the point is not on an orb', () => {
    expect(orbIdAtPoint(10, 20, { elementFromPoint: () => ({ closest: () => null }) })).toBeNull();
  });

  it('is null without a document', () => {
    expect(orbIdAtPoint(10, 20, null)).toBeNull();
  });
});
