import type {
  CustomerDetail,
  CustomerPointsRow,
  CustomerPointsType,
  CustomerRow,
  CustomerTransactionRow,
  CustomerTransactionType,
} from './apiTypes';

/**
 * Phase 18 — the only customer logic in the ERP browser, and it computes
 * no money and no points.
 *
 * THERE IS NO BALANCE, OUTSTANDING, LIFETIME-SPEND, POINTS OR LOYALTY-VALUE
 * ARITHMETIC HERE AND THERE MUST NEVER BE ANY. A customer's account
 * balance is `SUM(CustomerTransaction.amount)` and their points balance is
 * `SUM(CustomerPoints.points)`, both derived by the server on every read
 * from ledgers it alone can write. Summing a fetched PAGE of either would
 * produce a number that looks authoritative and is wrong the moment there
 * is a second page.
 *
 * The helpers below only COMPARE a server figure against zero to choose a
 * colour, which is the same posture `isOwed` takes for suppliers.
 */

/**
 * The list query accepts exactly these two filters. There is no email
 * filter, no balance filter, no ordering parameter and no branch scope,
 * so the screen offers none of them: a control the backend silently drops
 * is worse than one that is absent.
 */
export const CUSTOMER_LIST_FILTERS = ['search', 'isActive'] as const;

/**
 * The five fields `createCustomerSchema` accepts — and, `.partial()`ed,
 * the five `updateCustomerSchema` accepts. Written down so a form cannot
 * quietly grow a sixth: the schemas are non-strict, so an extra key is
 * DROPPED rather than rejected, and a credit-limit box would appear to
 * save a number the backend never stored.
 */
export const CUSTOMER_FIELDS = ['name', 'phone', 'email', 'address', 'taxNumber'] as const;

/**
 * A CONTRACT GAP, STATED ONCE HERE RATHER THAN GUESSED AT PER SCREEN.
 *
 * `DELETE /sales/customers/:id` deactivates, and nothing reactivates.
 * `updateCustomerSchema` does not accept `isActive`, and because the
 * schema is non-strict a `PATCH {isActive: true}` returns **200 OK having
 * changed nothing** — verified against the running backend. So this app
 * offers no reactivate control: one would report success and leave the
 * customer inactive, which is worse than not offering it. Reported at the
 * Phase 18 gate; not worked around here.
 */
export const CUSTOMER_REACTIVATION_UNSUPPORTED = true;

/**
 * `GetCustomerUseCase` takes the newest 100 ledger rows and offers no
 * paging over them, so the screen says so rather than implying the list
 * is the customer's whole history.
 */
export const CUSTOMER_TRANSACTION_CAP = 100;

export function customerTone(customer: Pick<CustomerRow, 'isActive'>): 'success' | 'neutral' {
  return customer.isActive ? 'success' : 'neutral';
}

/** Deactivation is offered only on an active customer: the server 409s on
 *  one that is already inactive, and the control should not invite it. */
export function canDeactivateCustomer(customer: Pick<CustomerRow, 'isActive'>): boolean {
  return customer.isActive;
}

/**
 * The customer owes the business. A COMPARISON against the server's own
 * figure, never a subtraction: positive means owed to the business,
 * negative means the business holds their money (an overpayment, or
 * return credit beyond what they owed).
 */
export function owesBusiness(customer: Pick<CustomerRow, 'balance'>): boolean {
  const n = Number(customer.balance);
  return Number.isFinite(n) && n > 0;
}

export function inCredit(customer: Pick<CustomerRow, 'balance'>): boolean {
  const n = Number(customer.balance);
  return Number.isFinite(n) && n < 0;
}

/** Whether the ledger row moved the balance up or down, read from the
 *  SIGN the server stored rather than inferred from the row's type. */
export function ledgerDirection(row: Pick<CustomerTransactionRow, 'amount'>): 'up' | 'down' | 'flat' {
  const n = Number(row.amount);
  if (!Number.isFinite(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}

export function transactionTone(type: CustomerTransactionType): 'brand' | 'success' | 'warning' | 'neutral' {
  if (type === 'SALE') return 'brand';
  if (type === 'PAYMENT') return 'success';
  if (type === 'SALE_RETURN') return 'warning';
  return 'neutral';
}

export function pointsTone(type: CustomerPointsType): 'success' | 'warning' | 'danger' | 'neutral' {
  if (type === 'EARN') return 'success';
  if (type === 'REDEEM') return 'warning';
  if (type === 'RETURN_CLAWBACK') return 'danger';
  return 'neutral';
}

/** Whether a points event added to the balance. Again a comparison of the
 *  SIGNED figure the ledger stored — the type alone does not say, because
 *  an ADJUSTMENT may go either way. */
export function pointsAdded(row: Pick<CustomerPointsRow, 'points'>): boolean {
  const n = Number(row.points);
  return Number.isFinite(n) && n > 0;
}

/** Whether the customer has any loyalty history at all, from the server's
 *  own event count — not from the length of the page we happen to hold. */
export function hasLoyaltyHistory(balance: { eventCount: number }): boolean {
  return balance.eventCount > 0;
}

/** Whether the detail response was truncated at the server's cap, so the
 *  screen can say "the most recent 100" instead of implying completeness. */
export function ledgerMayBeTruncated(customer: Pick<CustomerDetail, 'recentTransactions'>): boolean {
  return customer.recentTransactions.length >= CUSTOMER_TRANSACTION_CAP;
}

/** A customer with nothing but a name still has to render as something. */
export function contactLine(customer: Pick<CustomerRow, 'phone' | 'email'>): string | null {
  return [customer.phone, customer.email].filter(Boolean).join(' · ') || null;
}
