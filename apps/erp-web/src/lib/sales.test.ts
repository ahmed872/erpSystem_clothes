import { describe, expect, it } from 'vitest';
import * as sales from './sales';
import {
  LIST_HAS_NO_PAYMENT_SUMMARY,
  SALE_LIST_FILTERS,
  canRecordPayment,
  hasCost,
  hasProfit,
  hasReturns,
  isExchangeSale,
  isFullyReturned,
  isOutstanding,
  isPartiallyReturned,
  paymentTone,
  saleTone,
} from './sales';
import type { SaleDetail, SaleItemRow, SalePaymentStatus, SaleReturnRow, SaleStatus } from './apiTypes';

/**
 * Phase 17.
 *
 * The first case is the point of the module and is asserted
 * mechanically: this file exports NO sale calculator. Every figure on a
 * sale — line total, discount, tax, promotion, loyalty, document total,
 * and the payment summary on top of it — was computed by the pipeline
 * that wrote the sale and frozen on the document. A browser that
 * recomputed any of it would be applying today's tax rate and today's
 * price list to a fact recorded months ago.
 */

function item(over: Partial<SaleItemRow> = {}): SaleItemRow {
  return {
    id: 'si-1',
    variantId: 'v1',
    quantity: '3',
    unitPrice: '100',
    discountAmount: '0',
    taxAmount: '45',
    taxRateSnapshot: '15',
    taxExempt: false,
    lineTotal: '345',
    quantityReturned: '0',
    ...over,
  };
}

function saleReturn(over: Partial<SaleReturnRow> = {}): SaleReturnRow {
  return {
    id: 'sr-1',
    returnNumber: 'RET-1',
    refundMethod: 'CASH',
    refundAmount: '100',
    reason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    items: [],
    ...over,
  };
}

function sale(over: Partial<SaleDetail> = {}): SaleDetail {
  return {
    id: 's-1',
    saleNumber: 'SL-1',
    status: 'COMPLETED',
    branchId: 'b1',
    warehouseId: 'w1',
    customerId: null,
    shiftId: 'sh1',
    subtotal: '300',
    discountAmount: '0',
    taxAmount: '45',
    totalAmount: '345',
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    exchangeForReturnId: null,
    customer: null,
    warehouse: null,
    paidAmount: '345',
    remainingAmount: '0',
    paymentStatus: 'PAID',
    items: [item()],
    payments: [],
    returns: [],
    shift: null,
    ...over,
  };
}

describe('the module boundary', () => {
  it('exports no sale calculator, and must never gain one', () => {
    for (const name of Object.keys(sales)) {
      expect(name).not.toMatch(/total|subtotal|amount|price|tax|discount|promotion|loyalty|calculate|compute|resolve/i);
    }
  });

  it('offers exactly the five filters the live list query accepts', () => {
    // Written down so a screen cannot quietly grow a date-range or status
    // control the backend would ignore: `saleListQuerySchema` accepts
    // these and nothing else, and an unknown key is dropped rather than
    // honoured — a filter that silently does nothing is worse than one
    // that is absent.
    expect([...SALE_LIST_FILTERS]).toEqual(['saleNumber', 'customerId', 'warehouseId', 'branchId', 'shiftId']);
    expect([...SALE_LIST_FILTERS]).not.toContain('status');
    expect([...SALE_LIST_FILTERS]).not.toContain('from');
    expect([...SALE_LIST_FILTERS]).not.toContain('to');
  });

  it('records that a list row carries no payment summary', () => {
    // `computePaymentSummary` runs in GetSaleUseCase only. Deriving a
    // status from `totalAmount` on the list would call every fully-paid
    // cash sale unpaid.
    expect(LIST_HAS_NO_PAYMENT_SUMMARY).toBe(true);
  });
});

describe('saleTone', () => {
  it('separates a completed sale from a voided one', () => {
    expect(saleTone('COMPLETED')).toBe('success');
    expect(saleTone('VOIDED')).toBe('danger');
  });

  it('covers every status in the live union', () => {
    for (const s of ['COMPLETED', 'VOIDED'] as SaleStatus[]) {
      expect(['success', 'danger']).toContain(saleTone(s));
    }
  });
});

describe('paymentTone', () => {
  it('gives each settlement state its own tone', () => {
    expect(paymentTone('PAID')).toBe('success');
    expect(paymentTone('PARTIALLY_PAID')).toBe('warning');
    expect(paymentTone('UNPAID')).toBe('danger');
  });

  it('covers every status in the live union', () => {
    for (const s of ['PAID', 'PARTIALLY_PAID', 'UNPAID'] as SalePaymentStatus[]) {
      expect(['success', 'warning', 'danger']).toContain(paymentTone(s));
    }
  });
});

describe('isOutstanding', () => {
  it('reads the SERVER paymentStatus, never a comparison of totals', () => {
    expect(isOutstanding({ paymentStatus: 'PAID' })).toBe(false);
    expect(isOutstanding({ paymentStatus: 'PARTIALLY_PAID' })).toBe(true);
    expect(isOutstanding({ paymentStatus: 'UNPAID' })).toBe(true);
  });

  it('calls an exchange-settled sale settled even with no cash against it', () => {
    // The case that makes subtracting payments from a total wrong: an
    // exchange credit settles the sale without a SalePayment row of the
    // full amount. Only `computePaymentSummary` knows that.
    expect(isOutstanding(sale({ paymentStatus: 'PAID', paidAmount: '0', payments: [] }))).toBe(false);
  });
});

describe('cost and profit visibility', () => {
  it('asks whether the response CARRIED the figure, not whether a grant is held', () => {
    // The server deletes nothing here — it never attaches the keys for a
    // caller without `products.view_cost`. Asking about the payload means
    // no client-side branch could be flipped to reveal a number that was
    // never sent.
    expect(hasCost(sale())).toBe(false);
    expect(hasProfit(sale())).toBe(false);
    expect(hasCost(sale({ totalCost: '800' }))).toBe(true);
    expect(hasProfit(sale({ grossProfit: '1600' }))).toBe(true);
  });

  it('treats the two independently — neither implies the other', () => {
    expect(hasProfit(sale({ totalCost: '800' }))).toBe(false);
    expect(hasCost(sale({ grossProfit: '1600' }))).toBe(false);
  });

  it('shows a zero cost, which is a fact, rather than hiding it as absent', () => {
    expect(hasCost(sale({ totalCost: '0' }))).toBe(true);
    expect(hasProfit(sale({ grossProfit: '0' }))).toBe(true);
  });
});

describe('returns against a sale', () => {
  it('flags a line with any quantity back', () => {
    expect(isPartiallyReturned(item({ quantityReturned: '0' }))).toBe(false);
    expect(isPartiallyReturned(item({ quantityReturned: '1' }))).toBe(true);
    expect(isPartiallyReturned(item({ quantityReturned: '3' }))).toBe(true);
  });

  it('separates a part-returned line from a fully-returned one', () => {
    expect(isFullyReturned(item({ quantity: '3', quantityReturned: '1' }))).toBe(false);
    expect(isFullyReturned(item({ quantity: '3', quantityReturned: '3' }))).toBe(true);
  });

  it('handles the decimal quantities the schema actually stores', () => {
    expect(isPartiallyReturned(item({ quantityReturned: '0.5' }))).toBe(true);
    expect(isFullyReturned(item({ quantity: '2.5', quantityReturned: '2.5' }))).toBe(true);
    expect(isFullyReturned(item({ quantity: '2.5', quantityReturned: '2.4' }))).toBe(false);
  });

  it('refuses to guess on a value that is not a number', () => {
    expect(isPartiallyReturned(item({ quantityReturned: '' }))).toBe(false);
    expect(isPartiallyReturned(item({ quantityReturned: 'x' }))).toBe(false);
    expect(isFullyReturned(item({ quantity: 'x', quantityReturned: '1' }))).toBe(false);
    expect(isFullyReturned(item({ quantity: '0', quantityReturned: '0' }))).toBe(false);
  });

  it('reports whether the sale has any return at all', () => {
    expect(hasReturns(sale())).toBe(false);
    expect(hasReturns(sale({ returns: [saleReturn()] }))).toBe(true);
  });
});

describe('isExchangeSale', () => {
  it('names where an exchange sale came from instead of showing a bare id', () => {
    expect(isExchangeSale(sale())).toBe(false);
    expect(isExchangeSale(sale({ exchangeForReturnId: 'sr-1' }))).toBe(true);
  });
});

describe('canRecordPayment', () => {
  it('offers the control only on a completed sale that still owes something', () => {
    expect(canRecordPayment({ status: 'COMPLETED', paymentStatus: 'UNPAID' })).toBe(true);
    expect(canRecordPayment({ status: 'COMPLETED', paymentStatus: 'PARTIALLY_PAID' })).toBe(true);
    expect(canRecordPayment({ status: 'COMPLETED', paymentStatus: 'PAID' })).toBe(false);
  });

  it('never offers it on a voided sale, whatever it still shows as owing', () => {
    for (const p of ['PAID', 'PARTIALLY_PAID', 'UNPAID'] as SalePaymentStatus[]) {
      expect(canRecordPayment({ status: 'VOIDED', paymentStatus: p })).toBe(false);
    }
  });

  it('is visibility only — `sales.pay` is checked separately and by the server', () => {
    // The helper answers "is there anything to pay", not "may this
    // caller pay it". Conflating them would put the grant check inside a
    // pure function the screen could bypass.
    expect(canRecordPayment(sale({ paymentStatus: 'UNPAID' }))).toBe(true);
  });
});
