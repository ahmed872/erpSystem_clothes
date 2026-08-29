import { Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';

/**
 * Points-per-currency-unit, read from the existing Phase 1 `Setting`
 * store - no new configuration table, exactly as the approved decision
 * requires (and exactly as `resolveAllowNegative` and
 * `resolveWarrantyDurationDays` already do).
 */
export const LOYALTY_EARN_RATE_SETTING_KEY = 'loyalty.points_per_currency_unit';

/**
 * Resolves the business's earning rate, or `null` when the business is
 * not running a loyalty programme at all.
 *
 * `null` is a deliberate and IMPORTANT distinction from a thrown error.
 * `resolveWarrantyDurationDays` throws when unconfigured, because
 * registering a warranty is an explicit request that cannot be honoured
 * without a duration. Earning is the opposite shape: it is a side effect
 * of an ordinary sale, and a business with no loyalty programme
 * configured must still be able to sell. Throwing here would break every
 * sale for every such business, which is plainly wrong; earning zero
 * points is not a guessed business rule but simply the absence of a
 * programme.
 *
 * An invalid stored value (non-numeric, zero, negative) is treated the
 * same as absent rather than silently coerced to some default: the one
 * thing this must never do is invent a rate.
 */
export async function resolveLoyaltyEarnRate(
  tx: TenantTx,
  businessId: string,
): Promise<Prisma.Decimal | null> {
  const setting = await tx.setting.findUnique({
    where: { businessId_key: { businessId, key: LOYALTY_EARN_RATE_SETTING_KEY } },
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

/**
 * BD-3, implemented literally:
 *
 *   pointsEarned = floor(loyaltyEligibleAmount × pointsPerCurrencyUnit)
 *
 * where `loyaltyEligibleAmount` is the NET MERCHANDISE amount - subtotal
 * after ALL discounts (manual, promotion and loyalty redemption alike)
 * and BEFORE tax. Computing that amount is the caller's job (Phase 8E's
 * Sales integration); this function's only responsibility is to turn it
 * into points, deterministically.
 *
 * Rounding is FLOOR, never half-up, per the approved decision - a
 * customer is never credited a point they have not fully earned. All
 * arithmetic is `Prisma.Decimal`; there is no floating-point step
 * anywhere in this path.
 *
 * A non-positive eligible amount earns nothing (a fully discounted sale
 * has no merchandise value to reward), and floor() already yields 0 for
 * any product below 1. Both cases return 0, and callers must record NO
 * ledger row for a zero result - the `customer_points_nonzero` CHECK
 * would reject it anyway.
 */
export function computePointsEarned(
  loyaltyEligibleAmount: Prisma.Decimal.Value,
  rate: Prisma.Decimal.Value,
): Prisma.Decimal {
  const eligible = new Prisma.Decimal(loyaltyEligibleAmount);
  const r = new Prisma.Decimal(rate);
  if (eligible.lessThanOrEqualTo(0) || r.lessThanOrEqualTo(0)) return new Prisma.Decimal(0);
  return eligible.times(r).floor();
}
