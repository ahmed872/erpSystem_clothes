import { Prisma } from '@prisma/client';
import { round4 } from '../../../common/domain/money';
import { computePointsEarned } from './loyalty-earning';

/**
 * The two loyalty consequences of a Sale Return. Both are driven by the
 * SAME cumulative return credit `C` that BD-1 defines and the refund
 * itself uses - there is deliberately no second notion of "how much of
 * this sale came back".
 *
 * Both are CUMULATIVE-DELTA calculations, never per-return proportional
 * multiplications. A naive per-return share accumulates rounding error:
 * three single-unit returns of a 5000-point redemption on a 3-unit line
 * would each restore `round4(5000/3) = 1666.6667`, totalling 5000.0001 -
 * more points than were ever spent. Computing the CUMULATIVE figure and
 * subtracting what was already recorded makes the deltas telescope to
 * exactly the original amount however the returns are split.
 *
 * Every input is a historical snapshot: the original EARN/REDEEM rows'
 * own `points`, `basisAmount` and `rateSnapshot`, plus the Sale's own
 * immutable `subtotal`/`discountAmount`. Current loyalty configuration
 * is never consulted, so changing a rate after the sale cannot alter
 * what is clawed back or restored.
 */

/**
 * Approved rule §6.2, applied cumulatively:
 *
 *   retained     = max(B - C, 0)
 *   totalOwed    = P - floor(retained x r)
 *   thisClawback = totalOwed - alreadyClawedBack
 *
 * where `P`, `B` and `r` are the ORIGINAL earning row's `points`,
 * `basisAmount` and `rateSnapshot`. Returned magnitude is non-negative;
 * the caller writes it as a NEGATIVE `RETURN_CLAWBACK` row.
 *
 * `retained` is clamped at zero so a fully returned sale always claws
 * back the entire earning, and the result is clamped to `[0, P]` so no
 * arithmetic edge can ever claw back more points than were earned.
 */
export function computeCumulativeClawback(
  originalPointsEarned: Prisma.Decimal,
  originalBasisAmount: Prisma.Decimal,
  originalRateSnapshot: Prisma.Decimal,
  cumulativeReturnCredit: Prisma.Decimal,
  alreadyClawedBack: Prisma.Decimal,
): Prisma.Decimal {
  const retained = Prisma.Decimal.max(originalBasisAmount.minus(cumulativeReturnCredit), 0);
  const retainedPoints = computePointsEarned(retained, originalRateSnapshot);
  const totalOwed = Prisma.Decimal.max(
    Prisma.Decimal.min(originalPointsEarned.minus(retainedPoints), originalPointsEarned),
    0,
  );
  return Prisma.Decimal.max(totalOwed.minus(alreadyClawedBack), 0);
}

export interface RedemptionRestoration {
  /** Points to hand back on this return (positive). */
  points: Prisma.Decimal;
  /** The monetary value those points represented at the ORIGINAL rate -
   * recorded on the row as `basisAmount`, also a cumulative delta so the
   * values across all returns sum exactly to the original redemption. */
  value: Prisma.Decimal;
}

/**
 * Approved decision BD-8 (restore redeemed points), applied cumulatively:
 *
 *   cumulativeRestoredPoints = round4(K x C / B)
 *   cumulativeRestoredValue  = round4(V x C / B)
 *
 * and each return records the DIFFERENCE from what has already been
 * restored. `K` and `V` are the original REDEEM row's `|points|` and
 * `basisAmount`; `B` is the sale's own merchandise amount; `C` is the
 * shared cumulative return credit.
 *
 * The required properties hold by construction:
 *   - a full return has `C = B`, so the cumulative figure is `round4(K)`
 *     = `K` exactly (points are stored at the same 4 dp scale),
 *   - sequential partial returns telescope to exactly `K`,
 *   - `C` is monotone non-decreasing and bounded by `B`, and `round4` is
 *     monotone, so no sequence can ever restore more than `K`,
 *   - the same return can never restore twice: the database's partial
 *     unique index permits at most one REDEMPTION_RESTORATION row per
 *     SaleReturn.
 */
export function computeCumulativeRestoration(
  originalRedeemedPoints: Prisma.Decimal,
  originalRedemptionValue: Prisma.Decimal,
  saleMerchandiseAmount: Prisma.Decimal,
  cumulativeReturnCredit: Prisma.Decimal,
  alreadyRestoredPoints: Prisma.Decimal,
  alreadyRestoredValue: Prisma.Decimal,
): RedemptionRestoration {
  if (saleMerchandiseAmount.lessThanOrEqualTo(0)) {
    return { points: new Prisma.Decimal(0), value: new Prisma.Decimal(0) };
  }

  const ratioNumerator = Prisma.Decimal.min(cumulativeReturnCredit, saleMerchandiseAmount);
  const cumulativePoints = round4(originalRedeemedPoints.times(ratioNumerator).dividedBy(saleMerchandiseAmount));
  const cumulativeValue = round4(originalRedemptionValue.times(ratioNumerator).dividedBy(saleMerchandiseAmount));

  return {
    points: Prisma.Decimal.max(cumulativePoints.minus(alreadyRestoredPoints), 0),
    value: Prisma.Decimal.max(cumulativeValue.minus(alreadyRestoredValue), 0),
  };
}
