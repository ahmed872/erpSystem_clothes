import type { CashTransaction, CashTransactionType, Shift } from './apiTypes';
import { parseMoney } from './money';

/**
 * Phase 12 (Cash Drawer) — the ONLY cash logic in the browser, and it is
 * deliberately not arithmetic.
 *
 * THERE IS NO `expectedCash()` FUNCTION HERE, AND THERE MUST NEVER BE ONE.
 * Expected cash is `openingFloat + SUM(cash_transactions.amount)`, derived
 * server-side in `finance/domain/shift-cash.ts`. Two things follow, and both
 * are load-bearing:
 *
 *   1. Computing it here would be a second cash engine, free to drift from
 *      the one the ledger and the variance posting actually use.
 *   2. Worse, it would DEFEAT BLIND CLOSE. The server strips `expectedCash`,
 *      `variance`, `cashIn` and `cashOut` from every shift response for a
 *      caller without `shifts.view_expected` — a cashier's device never
 *      receives the number. But `GET /sales/shifts/:id/cash-transactions` is
 *      gated on `shifts.view`, which a cashier DOES hold, so the raw signed
 *      movements are in the browser. Adding them up and putting the result
 *      on screen would hand the counting cashier the exact figure the whole
 *      design exists to withhold.
 *
 * So the movement list is rendered as an AUDIT TRAIL — what happened, when,
 * and why — and never as a running drawer total. `signedAmount` below
 * returns one row's own figure for display; nothing sums them.
 */

/** Whether the server actually sent this caller the expected-cash figures.
 * Absence means `shifts.view_expected` was not held — never that the shift
 * has no cash position. */
export function hasExpectedCashVisibility(shift: Shift | null | undefined): boolean {
  return shift !== null && shift !== undefined && shift.expectedCash !== undefined;
}

/** One movement's own signed value. Negative = cash left the drawer. */
export function signedAmount(movement: CashTransaction): number {
  return parseMoney(movement.amount);
}

/** Did this movement take money OUT of the drawer? Read from the sign the
 * SERVER applied, never inferred from the type in the browser — the sign is
 * the database's own CHECK-enforced fact. */
export function movesCashOut(movement: CashTransaction): boolean {
  return signedAmount(movement) < 0;
}

/** i18n key for a movement type, so an unknown future type degrades to its
 * raw code rather than rendering blank. */
export function movementLabelKey(type: CashTransactionType): string {
  return `cashDrawer.movement.${type}`;
}

/**
 * The shift state a cashier is actually in, as ONE value the UI can switch
 * on — so "no shift", "open", "closed" and "waiting for a manager" are
 * distinguishable rather than inferred from three nullable fields at every
 * call site.
 *
 * `AWAITING_RECONCILIATION` is not a stored status: the backend's `Shift`
 * has only OPEN and CLOSED. It is the honest reading of a CLOSED shift that
 * no manager has signed off yet, and it is derived from `reconciledAt`
 * alone — never from a variance figure, which a cashier is not sent.
 */
export type ShiftUiState = 'NONE' | 'OPEN' | 'AWAITING_RECONCILIATION' | 'CLOSED';

export function shiftUiState(shift: Shift | null | undefined): ShiftUiState {
  if (!shift) return 'NONE';
  if (shift.status === 'OPEN') return 'OPEN';
  return shift.reconciledAt === null ? 'AWAITING_RECONCILIATION' : 'CLOSED';
}

/**
 * How the server's variance reads to a human: an OVERAGE (more cash in the
 * drawer than the documents account for), a SHORTAGE, or balanced.
 *
 * Takes the SERVER's variance string and only classifies its sign. It does
 * not compute a variance, and returns `null` when the caller was not sent
 * one — the blind-close cashier — so the screen shows nothing rather than
 * a zero that would read as "balanced".
 */
export type VarianceKind = 'OVERAGE' | 'SHORTAGE' | 'BALANCED';

export function varianceKind(variance: string | null | undefined): VarianceKind | null {
  if (variance === null || variance === undefined) return null;
  const n = parseMoney(variance);
  if (n > 0.00005) return 'OVERAGE';
  if (n < -0.00005) return 'SHORTAGE';
  return 'BALANCED';
}
