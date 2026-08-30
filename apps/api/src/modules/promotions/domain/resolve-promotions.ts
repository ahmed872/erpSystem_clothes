import { Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { PromotionRule } from './promotion-calculation';

/**
 * Loads the promotions that could apply to a sale at a given instant.
 *
 * Eligibility is evaluated against the SALE'S OWN instant and the
 * promotion's stored half-open `[validFrom, validTo)` window, so a
 * boundary instant belongs to exactly one side - no gap and no overlap
 * between consecutive promotions. The window itself was resolved in the
 * business timezone when the promotion was created (see
 * `common/domain/business-timezone.ts`), so this comparison is a plain
 * instant comparison and needs no zone handling of its own.
 *
 * This runs INSIDE the sale's own transaction, so a promotion edited or
 * deactivated concurrently cannot produce a torn result: the sale sees
 * one consistent snapshot of configuration.
 *
 * Deliberately a plain read with no lock: with quotas and usage limits
 * explicitly deferred there is no counter to contend on, so promotions
 * introduce no new lock and no new edge in the canonical
 * Customer -> Sale -> StockBalance lock order.
 */
export async function resolveActivePromotions(tx: TenantTx, businessId: string, at: Date): Promise<PromotionRule[]> {
  const rows = await tx.promotion.findMany({
    where: {
      businessId,
      isActive: true,
      validFrom: { lte: at },
      validTo: { gt: at },
    },
    select: {
      id: true,
      name: true,
      type: true,
      targetType: true,
      targetId: true,
      percentageValue: true,
      fixedAmount: true,
      buyQuantity: true,
      getQuantity: true,
      validFrom: true,
    },
  });
  return rows;
}

/**
 * The BD-11 combination: a manual discount and a promotion discount are
 * ADDITIVE, capped at the line gross.
 *
 *     finalDiscount = min(manualDiscount + promotionDiscount, lineGross)
 *
 * A manual discount is not a promotion, so the no-stacking rule does not
 * reach it; the promotion is computed on the line GROSS, never on the
 * post-manual price. Exceeding the gross is capped, never rejected, and
 * the line's net merchandise value can therefore never go negative.
 *
 * Returns the promotion's EFFECTIVE contribution alongside the final
 * discount, because when the cap bites the promotion contributed less
 * than it computed - and it is the effective figure that
 * `SalePromotionApplication.discountApplied` must record, both so that
 * "what did promotions cost us" reporting is truthful and so that the
 * Sale's idempotency fingerprint can reconstruct the client's own
 * requested discount as `Sale.discountAmount - redemption - promotions`.
 */
export interface CombinedLineDiscount {
  finalDiscount: Prisma.Decimal;
  effectivePromotionDiscount: Prisma.Decimal;
  cappedAtLineGross: boolean;
}

export function combineManualAndPromotion(
  manualDiscount: Prisma.Decimal,
  promotionDiscount: Prisma.Decimal,
  lineGross: Prisma.Decimal,
): CombinedLineDiscount {
  const uncapped = manualDiscount.plus(promotionDiscount);
  const capped = uncapped.greaterThan(lineGross);
  const finalDiscount = capped ? lineGross : uncapped;
  // Never negative: if the manual discount alone already meets or exceeds
  // the gross, the promotion's effective contribution is zero.
  const effectivePromotionDiscount = Prisma.Decimal.max(finalDiscount.minus(manualDiscount), 0);
  return { finalDiscount, effectivePromotionDiscount, cappedAtLineGross: capped };
}
