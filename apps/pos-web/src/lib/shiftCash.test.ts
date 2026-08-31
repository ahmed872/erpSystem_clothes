import { describe, expect, it } from 'vitest';
import { hasExpectedCashVisibility, movementLabelKey, movesCashOut, shiftUiState, signedAmount, varianceKind } from './shiftCash';
import type { CashTransaction, CashTransactionType, Shift } from './apiTypes';

/**
 * Phase 12 (Cash Drawer).
 *
 * The most important assertion in this file is one that cannot be written
 * as a test case: there is no `expectedCash()` to call. Expected cash is
 * `openingFloat + SUM(movements)`, derived server-side, and a browser-side
 * copy would be both a second cash engine and a hole straight through blind
 * close — the cashier holds `shifts.view` and therefore holds the raw
 * movement rows. What IS tested below is that the helpers which do exist
 * only ever CLASSIFY figures the server sent, and never produce one.
 */

function shift(over: Partial<Shift> = {}): Shift {
  return {
    id: 's1',
    businessId: 'b1',
    branchId: 'br1',
    warehouseId: 'w1',
    cashRegisterId: 'r1',
    openedBy: 'u1',
    openedAt: '2026-01-01T08:00:00.000Z',
    openingFloat: '100',
    closedBy: null,
    closedAt: null,
    countedCash: null,
    reconciledBy: null,
    reconciledAt: null,
    reconciliationNote: null,
    status: 'OPEN',
    ...over,
  };
}

function movement(over: Partial<CashTransaction> = {}): CashTransaction {
  return {
    id: 'c1',
    businessId: 'b1',
    shiftId: 's1',
    type: 'SALE_TENDER',
    amount: '45',
    referenceType: 'Sale',
    referenceId: 'sale-1',
    reason: 'Sale INV-1',
    createdBy: 'u1',
    createdAt: '2026-01-01T09:00:00.000Z',
    ...over,
  };
}

describe('hasExpectedCashVisibility', () => {
  it('is false for a cashier, whose response has the field REMOVED rather than nulled', () => {
    // This is the shape the server actually sends a caller without
    // `shifts.view_expected`: the keys are absent entirely.
    expect(hasExpectedCashVisibility(shift())).toBe(false);
  });

  it('is true only when the server actually sent the figure', () => {
    expect(hasExpectedCashVisibility(shift({ expectedCash: '145' }))).toBe(true);
  });

  it('treats a zero expected figure as visible — 0 is an answer, not an absence', () => {
    expect(hasExpectedCashVisibility(shift({ expectedCash: '0' }))).toBe(true);
  });

  it('is false with no shift at all', () => {
    expect(hasExpectedCashVisibility(null)).toBe(false);
    expect(hasExpectedCashVisibility(undefined)).toBe(false);
  });
});

describe('signedAmount / movesCashOut', () => {
  it('reads the sign the SERVER applied rather than inferring it from the type', () => {
    expect(signedAmount(movement({ amount: '45' }))).toBe(45);
    expect(signedAmount(movement({ type: 'SALE_REFUND', amount: '-20' }))).toBe(-20);
  });

  it('a cash sale and a pay-in bring money in', () => {
    expect(movesCashOut(movement({ type: 'SALE_TENDER', amount: '45' }))).toBe(false);
    expect(movesCashOut(movement({ type: 'PAY_IN', amount: '50' }))).toBe(false);
  });

  it('a refund, a pay-out and a cash expense take money out', () => {
    expect(movesCashOut(movement({ type: 'SALE_REFUND', amount: '-20' }))).toBe(true);
    expect(movesCashOut(movement({ type: 'PAY_OUT', amount: '-30' }))).toBe(true);
    expect(movesCashOut(movement({ type: 'EXPENSE', amount: '-15' }))).toBe(true);
  });
});

describe('movementLabelKey', () => {
  it('names every type the endpoint can return, not only the two a cashier can key in', () => {
    const types: CashTransactionType[] = ['SALE_TENDER', 'SALE_REFUND', 'PAY_IN', 'PAY_OUT', 'EXPENSE'];
    expect(types.map(movementLabelKey)).toEqual([
      'cashDrawer.movement.SALE_TENDER',
      'cashDrawer.movement.SALE_REFUND',
      'cashDrawer.movement.PAY_IN',
      'cashDrawer.movement.PAY_OUT',
      'cashDrawer.movement.EXPENSE',
    ]);
  });
});

describe('shiftUiState', () => {
  it('distinguishes the four states a till can actually be in', () => {
    expect(shiftUiState(null)).toBe('NONE');
    expect(shiftUiState(shift({ status: 'OPEN' }))).toBe('OPEN');
    expect(shiftUiState(shift({ status: 'CLOSED', closedAt: '2026-01-01T17:00:00.000Z' }))).toBe('AWAITING_RECONCILIATION');
    expect(
      shiftUiState(shift({ status: 'CLOSED', closedAt: '2026-01-01T17:00:00.000Z', reconciledAt: '2026-01-02T09:00:00.000Z' })),
    ).toBe('CLOSED');
  });

  it('derives "awaiting reconciliation" from reconciledAt ALONE, never from a variance the cashier was not sent', () => {
    // A closed shift with no expected/variance fields at all - exactly what
    // a cashier receives - still reports the right state.
    const cashierView = shift({ status: 'CLOSED', closedAt: '2026-01-01T17:00:00.000Z', countedCash: '145' });
    expect(cashierView).not.toHaveProperty('variance');
    expect(shiftUiState(cashierView)).toBe('AWAITING_RECONCILIATION');
  });
});

describe('varianceKind', () => {
  it('classifies the SIGN of the server figure so a cashier reads words, not a minus sign', () => {
    expect(varianceKind('5')).toBe('OVERAGE');
    expect(varianceKind('-5')).toBe('SHORTAGE');
    expect(varianceKind('0')).toBe('BALANCED');
  });

  it('returns null when no variance was sent, so nothing renders for a blind-close cashier', () => {
    // The critical case: `undefined` must NOT fall through to BALANCED,
    // which would tell the cashier the drawer matched.
    expect(varianceKind(undefined)).toBeNull();
    expect(varianceKind(null)).toBeNull();
  });

  it('treats sub-cent noise as balanced rather than as a shortage', () => {
    expect(varianceKind('0.00001')).toBe('BALANCED');
    expect(varianceKind('-0.00001')).toBe('BALANCED');
  });

  it('classifies without recomputing: it is given the answer and only reads it', () => {
    // A deliberately "wrong" variance is still reported as the server
    // stated it - this helper has no opinion about what it should be.
    expect(varianceKind('-999')).toBe('SHORTAGE');
  });
});
