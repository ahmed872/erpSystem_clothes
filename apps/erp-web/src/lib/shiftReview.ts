import type { Shift } from './apiTypes';

/**
 * Phase 13 (ERP slice) — reading a shift, never recomputing one.
 *
 * THERE IS NO `expectedCash()` HERE AND THERE MUST NEVER BE ONE, for the
 * same reason `apps/pos-web/src/lib/shiftCash.ts` refuses to have one:
 * expected cash is `openingFloat + SUM(cash_transactions.amount)`, derived
 * server-side, and a second implementation in a browser would be free to
 * drift from the figure the variance was actually posted against.
 *
 * The ERP differs from the POS in ONE respect only: a reconciling user
 * holds `shifts.view_expected`, so the server sends them the figures. That
 * changes what is DISPLAYED, not who computes it.
 */

/**
 * A shift is reconcilable when it is CLOSED and no one has signed it off
 * yet — exactly the backend's two refusals (`Only a closed shift can be
 * reconciled`, `This shift has already been reconciled`). Read from
 * `status` and `reconciledAt`, never from a variance figure.
 */
export function isReconcilable(shift: Shift): boolean {
  return shift.status === 'CLOSED' && shift.reconciledAt === null;
}

/**
 * How the SERVER's variance reads to a human — an overage, a shortage, or
 * balanced. Classifies the sign of a figure it is given; it computes no
 * variance, and returns null when the caller was not sent one so a screen
 * shows nothing rather than a zero that would read as "balanced".
 */
export type VarianceKind = 'OVERAGE' | 'SHORTAGE' | 'BALANCED';

export function varianceKind(variance: string | null | undefined): VarianceKind | null {
  if (variance === null || variance === undefined) return null;
  // `Number('')` is 0, not NaN, so an empty string would otherwise be
  // classified BALANCED — stating that a drawer balanced on the strength
  // of a value that carries no figure at all.
  if (variance.trim() === '') return null;
  const n = Number(variance);
  if (!Number.isFinite(n)) return null;
  if (n > 0.00005) return 'OVERAGE';
  if (n < -0.00005) return 'SHORTAGE';
  return 'BALANCED';
}

/** The four states a shift row can be in, as one value the UI switches on. */
export type ShiftUiState = 'OPEN' | 'AWAITING_RECONCILIATION' | 'RECONCILED';

export function shiftUiState(shift: Shift): ShiftUiState {
  if (shift.status === 'OPEN') return 'OPEN';
  return shift.reconciledAt === null ? 'AWAITING_RECONCILIATION' : 'RECONCILED';
}
