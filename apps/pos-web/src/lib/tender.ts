/**
 * Phase 12 (Sale Quote) — the ONLY arithmetic the till performs.
 *
 * Everything a sale is worth - price, discount, promotion, loyalty, tax -
 * is computed by the server and arrives on the quote. What is left for the
 * client is the physical business of the drawer: how much of the amount due
 * is still untendered, and how much change to hand back when a customer
 * pays cash with a larger note.
 *
 * CHANGE IS NEVER SENT ANYWHERE. `POST /sales` refuses overpayment and
 * records only what the sale was worth, so the tender lines carry the
 * amount due and the change is settled at the drawer. That is why
 * `changeDue` is derived here and not on any request.
 *
 * All comparisons round to the 4-decimal monetary scale the API uses, so a
 * float sum of tenders can never disagree with the server over a fraction
 * of a cent and block an otherwise exact payment.
 */
const SCALE = 10_000;

/** Rounds to the API's 4-decimal monetary scale. */
export function toScale(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}

/** What still has to be tendered. Negative means over-tendered. */
export function outstanding(amountDue: number, payments: { amount: number }[]): number {
  const paid = payments.reduce((sum, p) => sum + (Number.isFinite(p.amount) ? p.amount : 0), 0);
  return toScale(amountDue - paid);
}

/**
 * Change to hand back: what the customer physically gave, less the cash
 * portion of the tender. Never negative - a shortfall is not change, it is
 * an unfinished payment, and `outstanding` is what reports that.
 */
export function changeDue(cashReceived: number, cashTendered: number): number {
  return Math.max(0, toScale(cashReceived - cashTendered));
}

/**
 * Whether the sale may be confirmed.
 *
 * A walk-in must tender the amount due EXACTLY - the server's rule, not a
 * client convention. An account customer may tender less, leaving the
 * balance on their ledger, but may never tender more: overpayment is
 * refused by the server either way.
 */
export function canConfirmTender(amountDue: number, payments: { amount: number }[], hasCustomer: boolean): boolean {
  const remaining = outstanding(amountDue, payments);
  if (remaining < -0.00005) return false;
  if (!hasCustomer && Math.abs(remaining) > 0.00005) return false;
  return true;
}
