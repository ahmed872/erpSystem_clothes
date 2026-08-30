import { Prisma, PromotionType, PromotionTargetType } from '@prisma/client';
import { round4 } from '../../../common/domain/money';

/**
 * The three approved promotion calculators, and nothing else. Every one
 * is a PURE function of the rule's own parameters and the line's own
 * gross - no database access, no current configuration lookup beyond the
 * candidate row itself, so the same inputs always produce the same
 * number.
 *
 * All three are bounded ABOVE by the line gross by construction, so a
 * promotion alone can never drive a line negative:
 *   - PERCENTAGE:   percentageValue <= 100 (CHECK-enforced)
 *   - FIXED_AMOUNT: explicit min() against the gross
 *   - BUY_X_GET_Y:  freeUnits <= quantity, so discount <= gross
 * The only way to exceed the gross is a MANUAL discount on top, which is
 * capped separately by the caller (approved decision BD-11).
 */

export interface PromotionRule {
  id: string;
  name: string;
  type: PromotionType;
  targetType: PromotionTargetType;
  targetId: string;
  percentageValue: Prisma.Decimal | null;
  fixedAmount: Prisma.Decimal | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  validFrom: Date;
}

export interface PromotableLine {
  variantId: string;
  productId: string;
  categoryId: string | null;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  /** `round4(unitPrice x quantity)` - computed once by the caller so the
   * engine and the sale's own subtotal can never disagree. */
  lineGross: Prisma.Decimal;
}

export function promotionMatchesLine(rule: PromotionRule, line: PromotableLine): boolean {
  switch (rule.targetType) {
    case 'VARIANT':
      return rule.targetId === line.variantId;
    case 'PRODUCT':
      return rule.targetId === line.productId;
    case 'CATEGORY':
      // Matched against the product's OWN category only. Child categories
      // are deliberately not walked: the approved policy names "Category"
      // as a target without defining descendant inheritance, and walking
      // the tree would be inventing scope.
      return line.categoryId !== null && rule.targetId === line.categoryId;
  }
}

/**
 * How many units this line gets free under a Buy-X-Get-Y rule.
 *
 * PER LINE ONLY (approved decision BD-10). Quantities are never
 * aggregated across variants, products or category lines, even when every
 * line matches the same promotion: a category "Buy 1 Get 1" over two
 * separate one-unit lines yields ZERO free units. That is the approved
 * behaviour, not a limitation - it keeps the calculation deterministic
 * and removes any need to decide which of two differently-priced units
 * would have been the free one.
 *
 *     freeUnits = floor(quantity / (X + Y)) x Y
 *
 * Y is INSIDE the set: a set is X + Y units, so "Buy 2 Get 1" needs 3
 * units on the line. The rule REPEATS for every whole multiple (6 units
 * of a 2+1 yield 2 free) and there is NO partial fulfilment - 5 units of
 * a 2+1 yield 1 free, not 1.67, because a remainder below X + Y completes
 * no set.
 *
 * `quantity` is a Decimal (the schema allows fractional quantities for
 * weighted goods), so the set count is floored on the Decimal itself
 * rather than assuming an integer.
 */
export function computeBxgyFreeUnits(quantity: Prisma.Decimal, buyQuantity: number, getQuantity: number): Prisma.Decimal {
  const setSize = new Prisma.Decimal(buyQuantity).plus(getQuantity);
  if (setSize.lessThanOrEqualTo(0)) return new Prisma.Decimal(0);
  const completeSets = quantity.dividedBy(setSize).floor();
  if (completeSets.lessThanOrEqualTo(0)) return new Prisma.Decimal(0);
  return completeSets.times(getQuantity);
}

export interface PromotionComputation {
  discount: Prisma.Decimal;
  /** Everything needed to reproduce this calculation later WITHOUT
   * reading the live Promotion row. */
  ruleSnapshot: Record<string, unknown>;
}

export function computePromotionDiscount(rule: PromotionRule, line: PromotableLine): PromotionComputation {
  const base = {
    promotionId: rule.id,
    type: rule.type,
    targetType: rule.targetType,
    targetId: rule.targetId,
    unitPriceAtSale: line.unitPrice.toString(),
    quantityAtSale: line.quantity.toString(),
    lineGrossAtSale: line.lineGross.toString(),
  };

  switch (rule.type) {
    case 'PERCENTAGE': {
      const pct = rule.percentageValue ?? new Prisma.Decimal(0);
      const discount = round4(line.lineGross.times(pct).dividedBy(100));
      return { discount, ruleSnapshot: { ...base, percentageValue: pct.toString(), computedDiscount: discount.toString() } };
    }
    case 'FIXED_AMOUNT': {
      const perUnit = rule.fixedAmount ?? new Prisma.Decimal(0);
      // PER UNIT, not per line - and never more than the line is worth.
      const raw = round4(perUnit.times(line.quantity));
      const discount = Prisma.Decimal.min(raw, line.lineGross);
      return {
        discount,
        ruleSnapshot: {
          ...base,
          fixedAmountPerUnit: perUnit.toString(),
          uncappedDiscount: raw.toString(),
          computedDiscount: discount.toString(),
        },
      };
    }
    case 'BUY_X_GET_Y': {
      const x = rule.buyQuantity ?? 0;
      const y = rule.getQuantity ?? 0;
      const freeUnits = computeBxgyFreeUnits(line.quantity, x, y);
      const discount = round4(freeUnits.times(line.unitPrice));
      return {
        discount,
        ruleSnapshot: {
          ...base,
          buyQuantity: x,
          getQuantity: y,
          freeUnits: freeUnits.toString(),
          computedDiscount: discount.toString(),
        },
      };
    }
  }
}
