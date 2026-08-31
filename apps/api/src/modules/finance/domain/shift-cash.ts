import { Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { round4 } from '../../../common/domain/money';

/**
 * Phase 10 (BD-17) — the cash arithmetic of a shift.
 *
 * EXPECTED CASH IS DERIVED, NEVER STORED. It is
 *
 *     openingFloat + SUM(cash_transactions.amount)
 *
 * over the shift, where `amount` is signed (tenders and pay-ins positive,
 * refunds, pay-outs and cash expenses negative) and the sign is guaranteed
 * to agree with the type by a database CHECK.
 *
 * Storing it would make it a second source of truth that could drift from
 * the movements it summarises, and - worse - could be edited to make a
 * variance disappear. Because `cash_transactions` is append-only at the
 * grant level (SELECT + INSERT only), the derivation is stable: the same
 * shift always yields the same expected figure, forever.
 *
 * The counted amount, by contrast, IS stored, because it is a fact about
 * the physical world that nothing else records. It is written exactly once
 * at close and never altered (BD-17 rule 6).
 */

export interface ShiftCashSummary {
  openingFloat: Prisma.Decimal;
  cashIn: Prisma.Decimal;
  cashOut: Prisma.Decimal;
  /** openingFloat + cashIn - cashOut. Derived. */
  expectedCash: Prisma.Decimal;
  /** NULL until the shift is closed. */
  countedCash: Prisma.Decimal | null;
  /**
   * countedCash - expectedCash. Positive = overage (more cash than the
   * documents account for), negative = shortage. NULL while open.
   */
  variance: Prisma.Decimal | null;
}

/**
 * Computes the cash position of one shift from its opening float and its
 * movement ledger. Callers that intend to close or reconcile the shift must
 * already hold the shift row lock, so the sum cannot race an insert.
 */
export async function computeShiftCash(
  tx: TenantTx,
  businessId: string,
  shift: { id: string; openingFloat: Prisma.Decimal; countedCash: Prisma.Decimal | null },
): Promise<ShiftCashSummary> {
  const rows = await tx.cashTransaction.findMany({
    where: { businessId, shiftId: shift.id },
    select: { amount: true },
  });

  let cashIn = new Prisma.Decimal(0);
  let cashOut = new Prisma.Decimal(0);
  for (const r of rows) {
    if (r.amount.isPositive()) cashIn = cashIn.plus(r.amount);
    else cashOut = cashOut.plus(r.amount.abs());
  }

  const openingFloat = new Prisma.Decimal(shift.openingFloat);
  const expectedCash = round4(openingFloat.plus(cashIn).minus(cashOut));
  const countedCash = shift.countedCash === null ? null : new Prisma.Decimal(shift.countedCash);

  return {
    openingFloat,
    cashIn: round4(cashIn),
    cashOut: round4(cashOut),
    expectedCash,
    countedCash,
    variance: countedCash === null ? null : round4(countedCash.minus(expectedCash)),
  };
}

/**
 * BD-17 rule 4 / rule 6 — BLIND CLOSE, enforced server-side.
 *
 * A caller without `shifts.view_expected` must never receive the expected
 * figure, the variance, or the movement totals that trivially reveal them.
 * The fields are REMOVED from the response entirely rather than nulled or
 * left for a screen to hide: a cashier's device never receives the number,
 * so no amount of tampering with the client surfaces it. This is the same
 * posture the system already takes for cost and profit fields.
 *
 * `openingFloat` and `countedCash` are deliberately NOT stripped - the
 * cashier supplied both themselves, so withholding them would be theatre,
 * and neither reveals what the documents say the drawer should hold.
 */
export const EXPECTED_CASH_FIELDS = ['expectedCash', 'variance', 'cashIn', 'cashOut'] as const;

export function applyExpectedCashVisibility<T extends Record<string, unknown>>(
  row: T,
  canViewExpected: boolean,
): T | Omit<T, (typeof EXPECTED_CASH_FIELDS)[number]> {
  if (canViewExpected) return row;
  const out = { ...row };
  for (const f of EXPECTED_CASH_FIELDS) delete (out as Record<string, unknown>)[f];
  return out;
}
