import { Injectable } from '@nestjs/common';
import { Prisma, TaxPricingMode } from '@prisma/client';
import { TenantTx } from '../../common/prisma/prisma.service';
import { round4 } from '../../common/domain/money';

/**
 * Phase 10 (BD-18) — the Tax Engine.
 *
 * One of the horizontal domain services the Phase 0 architecture names
 * (`InventoryEngine`, `AccountingEngine`, `PromotionEngine`, `TaxEngine`,
 * ...): injected into an application use-case, never called from a
 * controller, and holding no HTTP knowledge.
 *
 * THE ONE IDEA THIS ENGINE EXISTS TO PROTECT (approved resolution of
 * BLOCKING-1):
 *
 *   Tax-inclusive pricing is an ENTRY AND DISPLAY CONVENTION ONLY.
 *
 * When a business prices inclusively, every amount that arrives expressed
 * in shelf terms - the unit price, a manual discount, a fixed promotion
 * amount, a loyalty redemption value - is converted to its net equivalent
 * AT THE LINE BOUNDARY. From that point the existing tax-exclusive
 * pipeline runs completely unchanged, which is what keeps five already
 * approved decisions intact rather than reinterpreted:
 *
 *   BD-1  return credit          BD-2  redemption allocation
 *   BD-3  loyalty basis (net of discounts, BEFORE tax - still literally true)
 *   BD-11 promotion cap at line gross
 *   BD-12 manual discount cap at line gross
 *
 * There is deliberately NO second, inclusive-mode pipeline. A parallel set
 * of monetary rules would be the surest way to let the two drift apart.
 *
 * ROUNDING: `round4`, HALF-UP, the existing money policy (BD-6). No new
 * rounding rule is introduced. Extraction leaves a residual below one unit
 * of the fourth decimal place - an accepted, documented consequence of that
 * precision, not a defect to be patched with a special rule.
 */

/** The tax that applies to one line, already resolved. */
export interface ResolvedLineTax {
  /** NULL when the line is exempt or no tax applies. */
  taxId: string | null;
  /** Percentage, e.g. 14 for 14%. Zero when exempt or untaxed. */
  ratePercent: Prisma.Decimal;
  /** True only when exemption was EXPLICIT (BD-18 rule 8). */
  exempt: boolean;
}

export interface TaxContext {
  pricingMode: TaxPricingMode;
  defaultTaxId: string | null;
}

interface TaxRow {
  id: string;
  ratePercent: Prisma.Decimal;
  isActive: boolean;
}

const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);

@Injectable()
export class TaxEngineService {
  /**
   * Loads the business's pricing mode and default tax once per sale.
   */
  async loadContext(tx: TenantTx, businessId: string): Promise<TaxContext> {
    const business = await tx.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { taxPricingMode: true, defaultTaxId: true },
    });
    return { pricingMode: business.taxPricingMode, defaultTaxId: business.defaultTaxId };
  }

  /**
   * Resolves the applicable tax for one line, in strict precedence order:
   *
   *   1. an explicit line-level exemption          (BD-18 rule 8)
   *   2. an explicit product-level exemption       (BD-18 rule 8)
   *   3. the product's own tax
   *   4. the business default tax
   *   5. no tax
   *
   * Exemption ALWAYS wins and is never inferred from a missing rate: a
   * product with no tax configured is untaxed, which is a different fact
   * from a product that is exempt, and the two are recorded differently.
   *
   * An INACTIVE tax resolves to no tax rather than raising. Deactivating a
   * tax is how a business stops charging it; failing every sale until
   * someone reassigns every product would make deactivation unusable.
   */
  async resolveLineTax(
    tx: TenantTx,
    businessId: string,
    ctx: TaxContext,
    product: { taxId: string | null; taxExempt: boolean },
    lineExempt: boolean,
    taxCache: Map<string, TaxRow | null>,
  ): Promise<ResolvedLineTax> {
    if (lineExempt || product.taxExempt) {
      return { taxId: null, ratePercent: ZERO, exempt: true };
    }

    const taxId = product.taxId ?? ctx.defaultTaxId;
    if (!taxId) return { taxId: null, ratePercent: ZERO, exempt: false };

    let tax = taxCache.get(taxId);
    if (tax === undefined) {
      tax = await tx.tax.findFirst({
        where: { id: taxId, businessId },
        select: { id: true, ratePercent: true, isActive: true },
      });
      taxCache.set(taxId, tax);
    }
    if (!tax || !tax.isActive) return { taxId: null, ratePercent: ZERO, exempt: false };

    return { taxId: tax.id, ratePercent: tax.ratePercent, exempt: false };
  }

  /**
   * THE BOUNDARY CONVERSION.
   *
   * Converts an amount expressed in the business's own pricing convention
   * into the tax-exclusive value the pipeline works in.
   *
   *   EXCLUSIVE mode      the amount already IS net - returned unchanged
   *   INCLUSIVE mode      net = round4(amount / (1 + rate/100))
   *
   * An exempt or zero-rated line has a divisor of exactly 1, so the
   * conversion is the identity and no special case is needed.
   *
   * This is applied to EVERY amount entered in shelf terms, not only the
   * unit price. A cashier typing "50 off" in an inclusive shop means 50 off
   * the shelf price; converting the discount by the same divisor is what
   * makes that intent come true. Leaving it unconverted would take more off
   * the shelf price than the cashier typed.
   */
  toNet(amount: Prisma.Decimal.Value, tax: ResolvedLineTax, ctx: TaxContext): Prisma.Decimal {
    const value = new Prisma.Decimal(amount);
    if (ctx.pricingMode !== 'INCLUSIVE' || tax.ratePercent.isZero()) return round4(value);
    return round4(value.dividedBy(HUNDRED.plus(tax.ratePercent).dividedBy(HUNDRED)));
  }

  /**
   * The tax on one line, computed from the tax configuration on the
   * DISCOUNTED net value.
   *
   * Charging on the discounted amount follows from the approved resolution:
   * discounts operate on the resulting tax-exclusive values, and tax is then
   * calculated from the configuration. The customer is taxed on what they
   * actually pay, which is also what every retail jurisdiction expects.
   */
  computeLineTax(netLineValueAfterDiscounts: Prisma.Decimal, tax: ResolvedLineTax): Prisma.Decimal {
    if (tax.ratePercent.isZero()) return ZERO;
    const base = netLineValueAfterDiscounts.isNegative() ? ZERO : netLineValueAfterDiscounts;
    return round4(base.times(tax.ratePercent).dividedBy(HUNDRED));
  }

  /**
   * BD-1's cumulative method, applied to the tax column on a return.
   *
   * `cumulativeTax(q) = round4(lineTax x q / quantity)`, with each return
   * posting the DELTA between the new cumulative figure and the previous
   * one. This is not a new rule - it is the approved BD-1 arithmetic applied
   * to a second column, and it is essential rather than decorative: naive
   * per-return proportions drift by fractions that accumulate, which is the
   * exact defect BD-1 was written to eliminate. Three partial returns of a
   * line therefore reverse EXACTLY the tax that was charged, never a
   * fraction more or less.
   */
  cumulativeLineTax(lineTax: Prisma.Decimal, lineQuantity: Prisma.Decimal, cumulativeReturnedQuantity: Prisma.Decimal.Value): Prisma.Decimal {
    const q = new Prisma.Decimal(cumulativeReturnedQuantity);
    if (q.lessThanOrEqualTo(0) || lineQuantity.lessThanOrEqualTo(0)) return ZERO;
    if (q.greaterThanOrEqualTo(lineQuantity)) return round4(lineTax);
    return round4(lineTax.times(q).dividedBy(lineQuantity));
  }
}
