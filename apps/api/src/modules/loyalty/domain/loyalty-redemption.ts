import { Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { floor4, round4, MONEY_STEP } from '../../../common/domain/money';

/**
 * Currency value PER POINT - fixed by approved decision BD-2, whose
 * formula is `redeemedPoints x redemptionRate`. Multiplying points by
 * the rate must yield money, so the rate is currency-per-point (e.g.
 * 0.01 means 100 points are worth 1.00).
 *
 * Deliberately NOT named as the mirror of Phase 8B's
 * `loyalty.points_per_currency_unit`: the two are independent business
 * settings, and a mirrored name would invite the false assumption that
 * one is the reciprocal of the other. A business may perfectly well earn
 * at one ratio and redeem at another.
 */
export const LOYALTY_REDEEM_RATE_SETTING_KEY = 'loyalty.currency_per_point';

/**
 * Resolves the redemption rate, or `null` when the business has not
 * configured redemption.
 *
 * Unlike `resolveLoyaltyEarnRate`, whose `null` simply means "no points
 * are earned", a `null` here must FAIL a redemption request rather than
 * silently skip it: earning is a passive side effect of a sale, but
 * redemption is something the customer explicitly asked for. An invalid
 * stored value is treated exactly like an absent one - the one thing
 * this must never do is invent a rate.
 */
export async function resolveLoyaltyRedeemRate(tx: TenantTx, businessId: string): Promise<Prisma.Decimal | null> {
  const setting = await tx.setting.findUnique({
    where: { businessId_key: { businessId, key: LOYALTY_REDEEM_RATE_SETTING_KEY } },
  });
  const raw = setting?.value;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;

  let rate: Prisma.Decimal;
  try {
    rate = new Prisma.Decimal(raw);
  } catch {
    return null;
  }
  if (!rate.isFinite() || rate.lessThanOrEqualTo(0)) return null;
  return rate;
}

/** BD-2: `V = round4(K x rho)`. 4 dp HALF-UP per approved decision BD-6. */
export function computeRedemptionValue(points: Prisma.Decimal.Value, rate: Prisma.Decimal.Value): Prisma.Decimal {
  return round4(new Prisma.Decimal(points).times(rate));
}

export interface AllocatableLine {
  /** Stable identity within the sale. `SaleItem.id` does not exist yet at
   * allocation time (rows are inserted after totals are computed), and
   * `variantId` is unique per sale - guaranteed by the
   * `@@unique([saleId, variantId])` index AND by CreateSaleUseCase's own
   * duplicate check - so it is a genuine line identity, not a fallback. */
  variantId: string;
  /** Merchandise value still available to discount: the line's gross
   * (rounded to the monetary scale) minus any discount already applied
   * to it by the caller. Tax is excluded - loyalty never discounts tax. */
  eligible: Prisma.Decimal;
}

/**
 * Allocates a redemption value across sale lines (approved decision
 * BD-2), preserving the invariant
 * `Sale.discountAmount = SUM(SaleItem.discountAmount)` by folding the
 * result into each line's own discount rather than inventing a
 * sale-level discount.
 *
 * LARGEST-REMAINDER WITH A PER-LINE CAP:
 *   1. Lines are ordered by `variantId` ascending - the same canonical
 *      order CreateSaleUseCase already uses for lock acquisition, and
 *      deterministic for identical input.
 *   2. Each line's exact share is `value x eligible_i / total`, truncated
 *      DOWN to the monetary scale, leaving a remainder per line.
 *   3. The shortfall is handed out one monetary step at a time to the
 *      largest remainders, ties broken by `variantId`, skipping any line
 *      already at its cap.
 *
 * The result sums EXACTLY to `value` and no line ever exceeds its own
 * eligible amount. Both properties hold by construction, not by luck:
 * since `value <= total`, each exact share is at most that line's
 * eligible amount, so truncating keeps it under the cap; and the
 * remaining capacity `total - assigned` is always at least the
 * outstanding shortfall `value - assigned`, so every step has somewhere
 * to go.
 *
 * Decimal arithmetic throughout - no floating point at any step.
 */
export function allocateRedemption(lines: AllocatableLine[], value: Prisma.Decimal): Map<string, Prisma.Decimal> {
  const ordered = [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
  const total = ordered.reduce((sum, l) => sum.plus(l.eligible), new Prisma.Decimal(0));

  const allocation = new Map<string, Prisma.Decimal>();
  for (const line of ordered) allocation.set(line.variantId, new Prisma.Decimal(0));
  if (value.lessThanOrEqualTo(0) || total.lessThanOrEqualTo(0)) return allocation;

  const remainders: { variantId: string; remainder: Prisma.Decimal }[] = [];
  let assigned = new Prisma.Decimal(0);
  for (const line of ordered) {
    const exact = value.times(line.eligible).dividedBy(total);
    const base = floor4(exact);
    allocation.set(line.variantId, base);
    remainders.push({ variantId: line.variantId, remainder: exact.minus(base) });
    assigned = assigned.plus(base);
  }

  // Hand out the shortfall deterministically: largest remainder first,
  // `variantId` as the tie-break so identical input always produces an
  // identical result.
  remainders.sort((a, b) => {
    const cmp = b.remainder.comparedTo(a.remainder);
    return cmp !== 0 ? cmp : a.variantId.localeCompare(b.variantId);
  });

  const capByVariant = new Map(ordered.map((l) => [l.variantId, l.eligible]));
  let shortfall = value.minus(assigned);
  while (shortfall.greaterThan(0)) {
    let placed = false;
    for (const { variantId } of remainders) {
      if (shortfall.lessThanOrEqualTo(0)) break;
      const current = allocation.get(variantId)!;
      if (current.plus(MONEY_STEP).greaterThan(capByVariant.get(variantId)!)) continue;
      allocation.set(variantId, current.plus(MONEY_STEP));
      shortfall = shortfall.minus(MONEY_STEP);
      placed = true;
    }
    // Unreachable while `value <= total` (proved above); guards against an
    // infinite loop rather than silently mis-allocating if a caller ever
    // violates that precondition.
    if (!placed) break;
  }

  return allocation;
}
