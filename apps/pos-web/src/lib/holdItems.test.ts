import { describe, expect, it } from 'vitest';
import { basketMatchesHold, canHold, holdItemsFromCart, holdUnitCount, indicativeValue } from './holdItems';
import type { CartLine } from '../store/cartStore';
import type { HeldSale, HeldSaleItem } from './apiTypes';

/**
 * Phase 12 (Held Sales) — the only logic in the browser worth testing,
 * because it is the only logic there is.
 *
 * Note what is NOT here: no tax, no promotion, no loyalty, no total that
 * anything is allowed to depend on. `indicativeValue` is asserted to be a
 * flat quantity x price less manual discount precisely so that the day
 * someone tries to sneak tax into it, this test says no.
 */

function line(over: Partial<CartLine> = {}): CartLine {
  return {
    key: 'v1',
    variantId: 'v1',
    sku: 'SKU-1',
    productName: 'Coat',
    variantLabel: 'Blue / M',
    tracksSerialNumbers: false,
    unitPrice: 100,
    quantity: 1,
    discountAmount: 0,
    serials: [],
    ...over,
  };
}

function item(over: Partial<HeldSaleItem> = {}): HeldSaleItem {
  return {
    id: 'i1',
    heldSaleId: 'h1',
    variantId: 'v1',
    quantity: '1',
    unitPrice: '100',
    discountAmount: '0',
    taxExempt: false,
    serials: [],
    ...over,
  };
}

function hold(items: HeldSaleItem[]): HeldSale {
  return {
    id: 'h1',
    businessId: 'b1',
    branchId: 'br1',
    warehouseId: 'w1',
    customerId: null,
    shiftId: 's1',
    holdNumber: 'HOLD-ABCD1234',
    status: 'OPEN',
    label: 'blue coat lady',
    notes: null,
    resumedSaleId: null,
    resumedAt: null,
    voidedAt: null,
    voidReason: null,
    createdBy: 'u1',
    createdAt: '2026-01-01T00:00:00.000Z',
    items,
  };
}

describe('holdItemsFromCart', () => {
  it('sends the sale-request shape and nothing else', () => {
    expect(holdItemsFromCart([line({ quantity: 3, unitPrice: 40, discountAmount: 5 })])).toEqual([
      { variantId: 'v1', quantity: 3, unitPrice: 40, discountAmount: 5, serials: undefined },
    ]);
  });

  it('carries serials for a serial-tracked line as INTENDED units', () => {
    const items = holdItemsFromCart([line({ tracksSerialNumbers: true, quantity: 2, serials: ['A1', 'A2'] })]);
    expect(items[0].serials).toEqual(['A1', 'A2']);
  });

  it('omits serials a non-tracked product could never have', () => {
    expect(holdItemsFromCart([line({ tracksSerialNumbers: false, serials: ['STRAY'] })])[0].serials).toBeUndefined();
  });

  it('omits an empty serial list rather than sending [] — a basket may be parked before the units are scanned', () => {
    expect(holdItemsFromCart([line({ tracksSerialNumbers: true, quantity: 2, serials: [] })])[0].serials).toBeUndefined();
  });
});

describe('indicativeValue', () => {
  it('is quantity x price less the MANUAL discount, and nothing more', () => {
    // Deliberately no tax and no promotion: those belong to a sale that
    // does not exist yet, and are resolved by the server at checkout.
    expect(indicativeValue([item({ quantity: '3', unitPrice: '40', discountAmount: '10' })])).toBe(110);
  });

  it('never goes negative on an over-large manual discount', () => {
    expect(indicativeValue([item({ quantity: '1', unitPrice: '10', discountAmount: '99' })])).toBe(0);
  });

  it('sums the basket', () => {
    expect(
      indicativeValue([
        item({ variantId: 'a', quantity: '2', unitPrice: '10' }),
        item({ variantId: 'b', quantity: '1', unitPrice: '5' }),
      ]),
    ).toBe(25);
  });
});

describe('holdUnitCount', () => {
  it('counts physical units, not lines', () => {
    expect(holdUnitCount([item({ variantId: 'a', quantity: '2' }), item({ variantId: 'b', quantity: '3' })])).toBe(5);
  });
});

describe('basketMatchesHold', () => {
  it('matches an untouched basket, so no needless write goes to the server', () => {
    expect(basketMatchesHold(hold([item({ quantity: '2', unitPrice: '50' })]), [line({ quantity: 2, unitPrice: 50 })])).toBe(true);
  });

  it('matches regardless of line ORDER — the cart is a set of variants, not a sequence', () => {
    const stored = hold([item({ id: 'i1', variantId: 'a' }), item({ id: 'i2', variantId: 'b' })]);
    const cart = [line({ key: 'b', variantId: 'b' }), line({ key: 'a', variantId: 'a' })];
    expect(basketMatchesHold(stored, cart)).toBe(true);
  });

  it('spots a changed quantity, a changed price and a changed discount', () => {
    const stored = hold([item({ quantity: '2', unitPrice: '50', discountAmount: '1' })]);
    expect(basketMatchesHold(stored, [line({ quantity: 3, unitPrice: 50, discountAmount: 1 })])).toBe(false);
    expect(basketMatchesHold(stored, [line({ quantity: 2, unitPrice: 60, discountAmount: 1 })])).toBe(false);
    expect(basketMatchesHold(stored, [line({ quantity: 2, unitPrice: 50, discountAmount: 2 })])).toBe(false);
  });

  it('spots an added and a removed line', () => {
    const stored = hold([item({ variantId: 'a' })]);
    expect(basketMatchesHold(stored, [line({ variantId: 'a' }), line({ key: 'b', variantId: 'b' })])).toBe(false);
    expect(basketMatchesHold(stored, [])).toBe(false);
  });

  it('spots a swapped variant even when the numbers are identical', () => {
    expect(basketMatchesHold(hold([item({ variantId: 'a' })]), [line({ variantId: 'b' })])).toBe(false);
  });

  it('SPOTS A SERIAL SCANNED AFTER THE BASKET WAS PARKED', () => {
    // The case this function exists for. A cashier parks a serial-tracked
    // basket with nothing scanned, comes back, scans the units - and the
    // resume would sell the SERVER's stored (empty) serials and be refused
    // by BD-13, unless the edit is written back first.
    const stored = hold([item({ quantity: '1', serials: [] })]);
    expect(basketMatchesHold(stored, [line({ tracksSerialNumbers: true, serials: ['SN-1'] })])).toBe(false);
  });

  it('treats the same serials in a different scan order as unchanged', () => {
    const stored = hold([item({ quantity: '2', serials: ['SN-1', 'SN-2'] })]);
    expect(basketMatchesHold(stored, [line({ tracksSerialNumbers: true, quantity: 2, serials: ['SN-2', 'SN-1'] })])).toBe(true);
  });
});

describe('canHold', () => {
  it('needs something in the basket', () => {
    expect(canHold([])).toBe(false);
    expect(canHold([line()])).toBe(true);
  });

  it('does NOT require serials — a basket is parked to clear the queue, and BD-13 is enforced at checkout', () => {
    expect(canHold([line({ tracksSerialNumbers: true, quantity: 2, serials: [] })])).toBe(true);
  });
});
