import { Prisma, PromotionTargetType } from '@prisma/client';
import { computePromotionDiscount, promotionMatchesLine, PromotableLine, PromotionRule } from './promotion-calculation';

/**
 * BEST APPLICABLE PROMOTION ONLY - never stacked (approved policy).
 *
 * Evaluation is PER LINE, which decision BD-10 makes policy rather than
 * an inference: with no basket-wide or threshold promotions in scope, and
 * BXGY explicitly per-line, a sale line is the only unit at which a
 * promotion can be scored. Two lines of one sale may legitimately carry
 * DIFFERENT promotions; a single line carries at most one.
 *
 * A manual discount never enters this competition - it is not a
 * promotion, and the no-stacking rule is scoped to promotions. It is
 * combined with the winner afterwards, capped at the line gross
 * (approved decision BD-11).
 *
 * "Best" means best FOR THE CUSTOMER: the largest discount wins. Ties are
 * broken deterministically so identical input always yields an identical
 * result:
 *
 *   1. largest discount            <- the policy
 *   2. most specific target        <- VARIANT > PRODUCT > CATEGORY
 *   3. earliest validFrom          <- the longer-standing offer
 *   4. lowest promotion id         <- total order, guarantees determinism
 *
 * Only (1) decides money. (2)-(4) cannot change the amount by definition -
 * they only decide WHICH of two equally valuable promotions is recorded
 * as the reason, so they invent no business rule.
 */

const SPECIFICITY: Record<PromotionTargetType, number> = {
  VARIANT: 0,
  PRODUCT: 1,
  CATEGORY: 2,
};

export interface SelectedPromotion {
  rule: PromotionRule;
  discount: Prisma.Decimal;
  ruleSnapshot: Record<string, unknown>;
}

export function selectBestPromotion(candidates: PromotionRule[], line: PromotableLine): SelectedPromotion | null {
  let best: SelectedPromotion | null = null;

  for (const rule of candidates) {
    if (!promotionMatchesLine(rule, line)) continue;

    const { discount, ruleSnapshot } = computePromotionDiscount(rule, line);
    // A promotion that reduces the line by nothing is not "applicable" -
    // recording it would produce a provenance row representing no money,
    // which `sale_promotion_applications_discount_positive` forbids
    // anyway.
    if (discount.lessThanOrEqualTo(0)) continue;

    if (best === null || beats(rule, discount, best)) {
      best = { rule, discount, ruleSnapshot };
    }
  }

  return best;
}

function beats(rule: PromotionRule, discount: Prisma.Decimal, current: SelectedPromotion): boolean {
  const byDiscount = discount.comparedTo(current.discount);
  if (byDiscount !== 0) return byDiscount > 0;

  const bySpecificity = SPECIFICITY[rule.targetType] - SPECIFICITY[current.rule.targetType];
  if (bySpecificity !== 0) return bySpecificity < 0;

  const byValidFrom = rule.validFrom.getTime() - current.rule.validFrom.getTime();
  if (byValidFrom !== 0) return byValidFrom < 0;

  return rule.id < current.rule.id;
}
