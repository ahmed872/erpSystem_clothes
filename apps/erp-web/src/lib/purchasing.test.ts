import { describe, expect, it } from 'vitest';
import * as purchasing from './purchasing';
import {
  canApprovePurchase,
  canCancelPurchase,
  canDeactivateSupplier,
  canEditPurchase,
  canPayPurchase,
  canReceivePurchase,
  canReturnPurchase,
  hasBalance,
  isFullyReceived,
  isOwed,
  outstandingQuantity,
  purchaseTone,
  returnableQuantity,
  supplierTone,
} from './purchasing';
import type { PurchaseItem, PurchaseStatus } from './apiTypes';

/**
 * Phase 16.
 *
 * The first case is the point of the module and is asserted
 * mechanically: this file exports NO money calculator. The server
 * computes every line total and document total in Decimal inside the
 * transaction that writes the order; a browser that added the same
 * numbers up would be a second calculator free to disagree with the one
 * that persists.
 */

function item(over: Partial<PurchaseItem> = {}): PurchaseItem {
  return {
    id: 'pi-1',
    purchaseId: 'po-1',
    variantId: 'v1',
    quantityOrdered: '10',
    quantityReceived: '0',
    quantityReturned: '0',
    unitCost: '100',
    taxAmount: '0',
    discountAmount: '0',
    lineTotal: '1000',
    ...over,
  };
}
const po = (status: PurchaseStatus, items: PurchaseItem[] = [item()]) => ({ status, items });

describe('the module boundary', () => {
  it('exports no money calculator, and must never gain one', () => {
    for (const name of Object.keys(purchasing)) {
      expect(name).not.toMatch(/total|subtotal|amount|price|tax|calculate|compute/i);
    }
  });
});

describe('the lifecycle', () => {
  it('allows editing ONLY a draft — the server 409s otherwise', () => {
    expect(canEditPurchase({ status: 'DRAFT' })).toBe(true);
    for (const s of ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'] as PurchaseStatus[]) {
      expect(canEditPurchase({ status: s })).toBe(false);
    }
  });

  it('allows approving ONLY a draft, and never an empty one', () => {
    // `ApprovePurchaseUseCase` refuses both — an order with no lines
    // commits the business to nothing.
    expect(canApprovePurchase(po('DRAFT'))).toBe(true);
    expect(canApprovePurchase(po('DRAFT', []))).toBe(false);
    expect(canApprovePurchase(po('APPROVED'))).toBe(false);
  });

  it('allows receiving only from APPROVED or PARTIALLY_RECEIVED', () => {
    // A DRAFT has not been committed to; a RECEIVED order has nothing
    // left; a CANCELLED one is closed.
    expect(canReceivePurchase({ status: 'APPROVED' })).toBe(true);
    expect(canReceivePurchase({ status: 'PARTIALLY_RECEIVED' })).toBe(true);
    for (const s of ['DRAFT', 'RECEIVED', 'CANCELLED'] as PurchaseStatus[]) {
      expect(canReceivePurchase({ status: s })).toBe(false);
    }
  });

  it('allows cancelling before completion, but never after', () => {
    for (const s of ['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED'] as PurchaseStatus[]) {
      expect(canCancelPurchase({ status: s })).toBe(true);
    }
    expect(canCancelPurchase({ status: 'RECEIVED' })).toBe(false);
    expect(canCancelPurchase({ status: 'CANCELLED' })).toBe(false);
  });

  it('never offers editing and receiving at the same time', () => {
    // They belong to different people: editing is the buyer's, receiving
    // is the warehouse's, and the states keep them apart.
    for (const s of ['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'] as PurchaseStatus[]) {
      expect(canEditPurchase({ status: s }) && canReceivePurchase({ status: s })).toBe(false);
    }
  });

  it('tones the five states distinctly', () => {
    const tones = (['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'] as PurchaseStatus[]).map(purchaseTone);
    expect(new Set(tones).size).toBe(5);
    expect(purchaseTone('RECEIVED')).toBe('success');
    expect(purchaseTone('CANCELLED')).toBe('danger');
  });
});

describe('canReturnPurchase', () => {
  it('needs something actually received to send back', () => {
    expect(canReturnPurchase(po('APPROVED', [item({ quantityReceived: '0' })]))).toBe(false);
    expect(canReturnPurchase(po('PARTIALLY_RECEIVED', [item({ quantityReceived: '4' })]))).toBe(true);
    expect(canReturnPurchase(po('RECEIVED', [item({ quantityReceived: '10' })]))).toBe(true);
  });

  it('refuses once everything received has already gone back', () => {
    expect(canReturnPurchase(po('RECEIVED', [item({ quantityReceived: '10', quantityReturned: '10' })]))).toBe(false);
  });

  it('never offers a return on a DRAFT or a CANCELLED order', () => {
    expect(canReturnPurchase(po('DRAFT', [item({ quantityReceived: '4' })]))).toBe(false);
    expect(canReturnPurchase(po('CANCELLED', [item({ quantityReceived: '4' })]))).toBe(false);
  });
});

describe('canPayPurchase', () => {
  it('allows payment against a committed order but not a draft or a cancellation', () => {
    for (const s of ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED'] as PurchaseStatus[]) {
      expect(canPayPurchase({ status: s })).toBe(true);
    }
    expect(canPayPurchase({ status: 'DRAFT' })).toBe(false);
    expect(canPayPurchase({ status: 'CANCELLED' })).toBe(false);
  });
});

describe('outstandingQuantity', () => {
  it('is what is still to arrive, from the server’s own running totals', () => {
    // `quantityReceived` is incremented inside the receive transaction
    // while holding the purchase-row lock; the server re-checks
    // over-receiving itself.
    expect(outstandingQuantity(item({ quantityOrdered: '10', quantityReceived: '4' }))).toBe(6);
    expect(outstandingQuantity(item({ quantityOrdered: '10', quantityReceived: '10' }))).toBe(0);
  });

  it('never goes negative, even if the figures disagree', () => {
    expect(outstandingQuantity(item({ quantityOrdered: '10', quantityReceived: '12' }))).toBe(0);
  });

  it('is 0 rather than NaN on a broken figure', () => {
    expect(outstandingQuantity(item({ quantityOrdered: 'x' }))).toBe(0);
  });
});

describe('returnableQuantity', () => {
  it('is what arrived less what has already gone back', () => {
    expect(returnableQuantity(item({ quantityReceived: '10', quantityReturned: '3' }))).toBe(7);
    expect(returnableQuantity(item({ quantityReceived: '0' }))).toBe(0);
  });

  it('never goes negative', () => {
    expect(returnableQuantity(item({ quantityReceived: '3', quantityReturned: '5' }))).toBe(0);
  });
});

describe('isFullyReceived', () => {
  it('is true only when every line has arrived in full', () => {
    expect(isFullyReceived({ items: [item({ quantityReceived: '10' })] })).toBe(true);
    expect(isFullyReceived({ items: [item({ quantityReceived: '10' }), item({ quantityReceived: '4' })] })).toBe(false);
  });
});

describe('suppliers', () => {
  it('offers deactivation only for an active supplier', () => {
    // The backend adds a second refusal this cannot see — an open
    // purchase blocks it — and answers with a 409 the screen shows
    // verbatim rather than trying to predict.
    expect(canDeactivateSupplier({ isActive: true })).toBe(true);
    expect(canDeactivateSupplier({ isActive: false })).toBe(false);
  });

  it('tones an inactive supplier neutrally, not as an error', () => {
    expect(supplierTone({ isActive: true })).toBe('success');
    expect(supplierTone({ isActive: false })).toBe('neutral');
  });

  it('asks whether a balance ARRIVED rather than recomputing one', () => {
    expect(hasBalance({ balance: '100' })).toBe(true);
    expect(hasBalance({})).toBe(false);
    // Zero is a figure, not an absence.
    expect(hasBalance({ balance: '0' })).toBe(true);
  });

  it('flags a supplier we owe from the SERVER’s computed balance', () => {
    expect(isOwed({ balance: '250' })).toBe(true);
    expect(isOwed({ balance: '0' })).toBe(false);
    expect(isOwed({})).toBe(false);
    expect(isOwed({ balance: 'x' })).toBe(false);
  });
});
