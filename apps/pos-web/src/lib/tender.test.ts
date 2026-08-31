import { describe, expect, it } from 'vitest';
import { canConfirmTender, changeDue, outstanding, toScale } from './tender';

describe('tender arithmetic (the only sums the till does itself)', () => {
  it('reports what is still owed', () => {
    expect(outstanding(100, [{ amount: 40 }])).toBe(60);
    expect(outstanding(100, [{ amount: 60 }, { amount: 40 }])).toBe(0);
    expect(outstanding(100, [])).toBe(100);
  });

  it('reports over-tender as a NEGATIVE outstanding, so it can be refused', () => {
    expect(outstanding(100, [{ amount: 120 }])).toBe(-20);
  });

  it('ignores a half-typed amount rather than producing NaN', () => {
    expect(outstanding(100, [{ amount: Number.NaN }])).toBe(100);
  });

  it('settles exactly at the 4-decimal scale the API uses', () => {
    // 106.9893 is a real total from a 7% tax on 3 x 33.33 - the kind of
    // figure float arithmetic gets wrong by a fraction of a cent.
    expect(outstanding(106.9893, [{ amount: 106.9893 }])).toBe(0);
    expect(canConfirmTender(106.9893, [{ amount: 106.9893 }], false)).toBe(true);
    expect(toScale(0.1 + 0.2)).toBe(0.3);
  });

  it('computes change, and never a negative one', () => {
    expect(changeDue(200, 154)).toBe(46);
    expect(changeDue(150, 150)).toBe(0);
    // Short payment is not negative change - it is an unfinished payment.
    expect(changeDue(100, 154)).toBe(0);
  });

  it('a WALK-IN must tender the amount due exactly', () => {
    expect(canConfirmTender(100, [{ amount: 100 }], false)).toBe(true);
    expect(canConfirmTender(100, [{ amount: 99 }], false)).toBe(false);
    expect(canConfirmTender(100, [{ amount: 101 }], false)).toBe(false);
  });

  it('an ACCOUNT CUSTOMER may underpay but never overpay', () => {
    expect(canConfirmTender(100, [{ amount: 40 }], true)).toBe(true);
    expect(canConfirmTender(100, [], true)).toBe(true);
    expect(canConfirmTender(100, [{ amount: 101 }], true)).toBe(false);
  });

  it('accepts a SPLIT TENDER that sums to the amount due', () => {
    expect(canConfirmTender(126, [{ amount: 100 }, { amount: 26 }], false)).toBe(true);
    expect(canConfirmTender(126, [{ amount: 100 }, { amount: 25 }], false)).toBe(false);
  });
});
