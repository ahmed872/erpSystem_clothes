import { describe, expect, it } from 'vitest';
import { isReconcilable, shiftUiState, varianceKind } from './shiftReview';
import * as shiftReview from './shiftReview';
import type { Shift } from './apiTypes';

/**
 * Phase 13 (ERP slice).
 *
 * The first case below is the whole point of this module and is asserted
 * mechanically: this file exports NO expected-cash calculator. Expected
 * cash is `openingFloat + SUM(cash_transactions.amount)`, derived
 * server-side and never stored, and a second implementation in a browser
 * would be free to drift from the figure the variance was actually posted
 * against at close.
 */

function shift(over: Partial<Shift> = {}): Shift {
  return {
    id: 's1',
    businessId: 'b1',
    branchId: 'br1',
    warehouseId: 'w1',
    cashRegisterId: 'r1',
    openedBy: 'u1',
    openedAt: '2026-03-01T08:00:00.000Z',
    openingFloat: '200.0000',
    closedBy: 'u1',
    closedAt: '2026-03-01T20:00:00.000Z',
    countedCash: '1150.0000',
    reconciledBy: null,
    reconciledAt: null,
    reconciliationNote: null,
    status: 'CLOSED',
    ...over,
  };
}

describe('the module boundary', () => {
  it('exports no expected-cash calculator, and must never gain one', () => {
    const names = Object.keys(shiftReview);
    expect(names).not.toContain('expectedCash');
    for (const name of names) {
      expect(name.toLowerCase()).not.toContain('expected');
    }
  });
});

describe('isReconcilable', () => {
  it('accepts a CLOSED shift nobody has signed off yet', () => {
    expect(isReconcilable(shift())).toBe(true);
  });

  it('refuses an OPEN shift — the backend refuses it too', () => {
    // "Only a closed shift can be reconciled". A drawer still taking
    // money has no final counted figure to acknowledge.
    expect(isReconcilable(shift({ status: 'OPEN', closedAt: null, countedCash: null }))).toBe(false);
  });

  it('refuses a shift already reconciled — reconciliation happens once', () => {
    expect(isReconcilable(shift({ reconciledAt: '2026-03-02T09:00:00.000Z', reconciledBy: 'u2' }))).toBe(false);
  });

  it('reads status and reconciledAt, NEVER a variance figure', () => {
    // A reconciler holds `shifts.view_expected` and is therefore sent a
    // variance; a shift that balanced exactly still needs signing off,
    // and one with a large shortage is not thereby disqualified.
    expect(isReconcilable(shift({ variance: '0.0000' }))).toBe(true);
    expect(isReconcilable(shift({ variance: '-500.0000' }))).toBe(true);
    // And a caller NOT sent the figures can still reconcile if granted.
    expect(isReconcilable(shift({ variance: undefined, expectedCash: undefined }))).toBe(true);
  });
});

describe('varianceKind', () => {
  it('classifies the SIGN of the server figure so a manager reads words', () => {
    expect(varianceKind('12.5000')).toBe('OVERAGE');
    expect(varianceKind('-12.5000')).toBe('SHORTAGE');
    expect(varianceKind('0.0000')).toBe('BALANCED');
  });

  it('returns null when the caller was NOT sent a variance', () => {
    // The blind-close rule: the server removes the key for a caller
    // without `shifts.view_expected`. Rendering a 0 there would state
    // "balanced" on a drawer whose variance is unknown to this user.
    expect(varianceKind(undefined)).toBeNull();
    expect(varianceKind(null)).toBeNull();
  });

  it('returns null rather than guessing when the value is not a number', () => {
    expect(varianceKind('')).toBeNull();
    expect(varianceKind('n/a')).toBeNull();
  });

  it('treats a sub-tenth-of-a-cent residue as balanced, matching money at 4dp', () => {
    expect(varianceKind('0.00001')).toBe('BALANCED');
    expect(varianceKind('-0.00001')).toBe('BALANCED');
    // But a real quarter-cent difference is still a difference.
    expect(varianceKind('0.0001')).toBe('OVERAGE');
  });
});

describe('shiftUiState', () => {
  it('names the three states a row can be in', () => {
    expect(shiftUiState(shift({ status: 'OPEN', closedAt: null }))).toBe('OPEN');
    expect(shiftUiState(shift())).toBe('AWAITING_RECONCILIATION');
    expect(shiftUiState(shift({ reconciledAt: '2026-03-02T09:00:00.000Z' }))).toBe('RECONCILED');
  });

  it('agrees with isReconcilable: exactly the AWAITING state is actionable', () => {
    const rows = [
      shift({ status: 'OPEN', closedAt: null }),
      shift(),
      shift({ reconciledAt: '2026-03-02T09:00:00.000Z' }),
    ];
    for (const s of rows) {
      expect(isReconcilable(s)).toBe(shiftUiState(s) === 'AWAITING_RECONCILIATION');
    }
  });
});
