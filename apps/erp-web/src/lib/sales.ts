import type { SaleDetail, SaleItemRow, SalePaymentStatus, SaleStatus } from './apiTypes';

/**
 * Phase 17 — the only sales logic in the ERP browser, and it computes no
 * money.
 *
 * THERE IS NO TOTAL, TAX, DISCOUNT, PROMOTION OR LOYALTY ARITHMETIC HERE
 * AND THERE MUST NEVER BE ANY. Every figure on a sale was computed by the
 * pipeline that wrote it and frozen on the document: reprinting a
 * six-month-old sale shows what it showed then, even though the tax rate,
 * the price list and the promotion have all changed since. A browser that
 * recomputed any of it would be asserting today's rules over a historical
 * fact.
 *
 * THE PAYMENT SUMMARY IS THE SERVER'S TOO. `paidAmount`,
 * `remainingAmount` and `paymentStatus` come from `computePaymentSummary`
 * on the detail; nothing here subtracts payments from a total.
 */

/**
 * A KNOWN LIMITATION, STATED ONCE HERE RATHER THAN GUESSED AT PER SCREEN.
 *
 * `GET /sales` returns the raw sale rows and does NOT include the payment
 * summary — `computePaymentSummary` runs only in `GetSaleUseCase`. So a
 * list row genuinely cannot say whether a sale is settled, and the list
 * screen does not show a payment column rather than deriving one from
 * `totalAmount` (which would say "unpaid" for every fully-paid cash sale).
 * Opening the sale answers the question.
 */
export const LIST_HAS_NO_PAYMENT_SUMMARY = true;

/**
 * The list query accepts exactly these. There is no date range and no
 * status filter in the live contract, so the screen offers neither.
 */
export const SALE_LIST_FILTERS = ['saleNumber', 'customerId', 'warehouseId', 'branchId', 'shiftId'] as const;

export function saleTone(status: SaleStatus): 'success' | 'danger' {
  return status === 'COMPLETED' ? 'success' : 'danger';
}

export function paymentTone(status: SalePaymentStatus): 'success' | 'warning' | 'danger' {
  if (status === 'PAID') return 'success';
  if (status === 'PARTIALLY_PAID') return 'warning';
  return 'danger';
}

/**
 * Whether an invoice still has something owing, read from the SERVER's
 * `paymentStatus` rather than by comparing totals. A sale settled with an
 * exchange credit is PAID even though its cash payments do not add up to
 * its total — only the server knows that.
 */
export function isOutstanding(sale: Pick<SaleDetail, 'paymentStatus'>): boolean {
  return sale.paymentStatus !== 'PAID';
}

/** Whether the caller was sent cost/profit at all. Asked instead of "does
 *  the user hold the grant", so no client-side branch could be flipped to
 *  reveal a figure the response never carried. */
export function hasCost(sale: Pick<SaleDetail, 'totalCost'>): boolean {
  return sale.totalCost !== undefined;
}

export function hasProfit(sale: Pick<SaleDetail, 'grossProfit'>): boolean {
  return sale.grossProfit !== undefined;
}

/**
 * Whether any of this sale has come back. Read from the line's own
 * `quantityReturned`, which the return pipeline maintains; the screen
 * flags the line and computes no refund.
 */
export function isPartiallyReturned(item: Pick<SaleItemRow, 'quantityReturned'>): boolean {
  const n = Number(item.quantityReturned);
  return Number.isFinite(n) && n > 0;
}

/** Whether the whole line went back. */
export function isFullyReturned(item: Pick<SaleItemRow, 'quantity' | 'quantityReturned'>): boolean {
  const sold = Number(item.quantity);
  const back = Number(item.quantityReturned);
  if (!Number.isFinite(sold) || !Number.isFinite(back)) return false;
  return sold > 0 && back >= sold;
}

/** Whether this sale has any return against it at all. */
export function hasReturns(sale: Pick<SaleDetail, 'returns'>): boolean {
  return sale.returns.length > 0;
}

/**
 * Whether this sale was itself created as an EXCHANGE for a return —
 * the `exchangeForReturnId` the sale pipeline sets. Named so the detail
 * screen can say where the sale came from instead of showing a bare id.
 */
export function isExchangeSale(sale: Pick<SaleDetail, 'exchangeForReturnId'>): boolean {
  return sale.exchangeForReturnId !== null;
}

/**
 * Whether to offer the "record a payment" control. Both halves matter:
 * the sale must still owe something AND the caller must hold `sales.pay`,
 * which the screen checks separately. The server refuses either way.
 */
export function canRecordPayment(sale: Pick<SaleDetail, 'paymentStatus' | 'status'>): boolean {
  return sale.status === 'COMPLETED' && sale.paymentStatus !== 'PAID';
}
