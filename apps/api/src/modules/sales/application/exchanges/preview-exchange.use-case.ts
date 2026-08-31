import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PreviewExchangeInput } from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { round4 } from '../../../../common/domain/money';
import { PreviewSaleReturnUseCase } from '../returns/preview-sale-return.use-case';
import { CreateSaleUseCase } from '../sales/create-sale.use-case';

/**
 * Phase 12 (Exchange preview) — THE OUTCOME, BEFORE THE MONEY MOVES.
 *
 * `CreateExchangeUseCase` enforces one settlement, in exactly one order it
 * can be known: return first (so its credit exists), replacement second
 * (so the credit can be applied to it), and then
 *
 *     requiredRefund = max(0, returnCredit - replacementTotal)
 *     creditApplied  = returnCredit - requiredRefund
 *     amountDue      = replacementTotal - creditApplied     (tendered by the customer)
 *
 * A till cannot show any of that before asking the server, for the same
 * reason `QuoteSaleUseCase` and `PreviewSaleReturnUseCase` exist: the
 * return credit is BD-1's cumulative apportionment plus BD-18's cumulative
 * tax reversal, and the replacement total depends on BD-18 tax resolution,
 * BD-10/BD-11 promotions and BD-2/BD-3 loyalty redemption — none of it
 * re-derivable client-side without a second, drifting implementation.
 *
 * THIS IS NOT A THIRD ENGINE. It computes nothing that was not already
 * computed somewhere else:
 *
 *   - the return half is `PreviewSaleReturnUseCase.computeInTx` — the
 *     EXACT function `GET .../returns/preview` calls, run here inside this
 *     preview's own transaction instead of its own;
 *   - the replacement half is `CreateSaleUseCase.quotePricing` — the EXACT
 *     function `POST /sales/quote` calls;
 *   - the settlement split is the three-line formula above, copied
 *     verbatim from where `CreateSaleUseCase.executeInTx` enforces it
 *     against an `exchange` context (see the comment there). It is
 *     arithmetic on two already-authoritative totals, not a new rule.
 *
 * SIDE-EFFECT FREEDOM IS ENFORCED BY POSTGRESQL, not by inspection. The
 * whole thing runs inside ONE `withTenantReadOnly` transaction — both
 * halves share it — so any INSERT, UPDATE, DELETE or `SELECT ... FOR
 * UPDATE` reaching it, today or after a future change to either shared
 * function, fails at the database. No SaleReturn, no Sale, no journal
 * entry, no stock movement, no loyalty row, no promotion application, no
 * serial transition, no cash transaction can be created from this path.
 *
 * A PREVIEW IS NOT A HOLD. Nothing is locked and nothing is reserved.
 * `POST /sales/:id/exchanges` re-resolves both halves from scratch under
 * its own locks and remains the only authority; a preview whose sale has
 * moved on simply produces an exchange that is refused or settled
 * differently.
 */
@Injectable()
export class PreviewExchangeUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly previewReturn: PreviewSaleReturnUseCase,
    private readonly sales: CreateSaleUseCase,
  ) {}

  async execute(actor: RequestUser, saleId: string, input: PreviewExchangeInput) {
    return this.prisma.withTenantReadOnly(actor.tenantId, async (tx) => {
      const original = await tx.sale.findFirst({
        where: { id: saleId, businessId: actor.tenantId },
        select: { id: true, warehouseId: true, customerId: true },
      });
      if (!original) throw new NotFoundDomainError('Sale', saleId);

      // HALF ONE, in the SAME transaction: what the returned goods are
      // worth. Reuses every eligibility check and the BD-1/BD-18
      // computation the real return's own preview runs.
      const returnPreview = await this.previewReturn.computeInTx(tx, actor, saleId, { items: input.returnItems });
      const returnCredit = new Prisma.Decimal(returnPreview.totals.totalRefundable);

      // HALF TWO, in the SAME transaction: what the replacement costs.
      // The warehouse and customer come from the ORIGINAL sale, never from
      // the request — identical to the real exchange, for the identical
      // reason (see CreateExchangeUseCase).
      const priced = await this.sales.quotePricing(tx, actor, {
        warehouseId: original.warehouseId,
        customerId: original.customerId ?? undefined,
        items: input.newItems,
        redeemPoints: input.redeemPoints,
        payments: [],
      });
      const replacementTotal = priced.totalAmount;

      // THE SETTLEMENT SPLIT — copied, not reinterpreted, from
      // `CreateSaleUseCase.executeInTx`'s exchange-context check.
      const surplus = returnCredit.minus(replacementTotal);
      const requiredRefund = round4(surplus.greaterThan(0) ? surplus : new Prisma.Decimal(0));
      const creditApplied = round4(returnCredit.minus(requiredRefund));
      const amountDue = round4(replacementTotal.minus(creditApplied));
      const direction: 'UPWARD' | 'EVEN' | 'DOWNWARD' =
        requiredRefund.greaterThan(0) ? 'DOWNWARD' : amountDue.greaterThan(0) ? 'UPWARD' : 'EVEN';

      const newLines = input.newItems.map((item) => {
        const gross = priced.lineGross.get(item.variantId)!;
        const manual = priced.cappedManual.get(item.variantId)!;
        const promotion = priced.effectivePromotionByVariant.get(item.variantId) ?? new Prisma.Decimal(0);
        const loyalty = priced.loyaltyDiscountByVariant.get(item.variantId) ?? new Prisma.Decimal(0);
        const tax = priced.lineTaxAmount.get(item.variantId)!;
        const resolvedTax = priced.lineTaxByVariant.get(item.variantId)!;
        const applied = priced.promotionByVariant.get(item.variantId);
        const variant = priced.variantsById.get(item.variantId)!;

        return {
          variantId: item.variantId,
          sku: variant.sku,
          quantity: new Prisma.Decimal(item.quantity).toString(),
          unitPrice: priced.netUnitPrice.get(item.variantId)!.toString(),
          discountAmount: round4(manual.plus(promotion).plus(loyalty)).toString(),
          taxAmount: tax.toString(),
          taxRatePercent: resolvedTax.taxId ? resolvedTax.ratePercent.toString() : null,
          lineTotal: round4(gross.minus(manual).minus(promotion).minus(loyalty).plus(tax)).toString(),
          promotion: applied ? { id: applied.rule.id, name: applied.rule.name, type: applied.rule.type } : null,
          requiresSerials: variant.product.tracksSerialNumbers,
        };
      });

      const availability = await this.readAvailability(tx, actor.tenantId, original.warehouseId, input.newItems);

      return {
        sale: returnPreview.sale,
        customer: returnPreview.customer,
        isWalkIn: returnPreview.isWalkIn,
        returnLines: returnPreview.lines,
        newLines,
        availability,
        direction,
        totals: {
          // What the returned goods are worth, BD-1 + BD-18.
          returnCredit: returnCredit.toString(),
          // What the replacement costs, fully resolved.
          replacementTotal: replacementTotal.toString(),
          // How much of the credit the replacement actually consumed.
          creditApplied: creditApplied.toString(),
          // Tender EXACTLY this on `POST /sales/:id/exchanges` — zero for
          // an even or downward exchange.
          amountDue: amountDue.toString(),
          // Send this as `refund.amount` — zero (omit `refund` entirely)
          // for an even or upward exchange.
          refundAmount: requiredRefund.toString(),
        },
        refund: {
          required: requiredRefund.greaterThan(0),
          requiredAmount: requiredRefund.greaterThan(0) ? requiredRefund.toString() : null,
        },
        previewedAt: new Date().toISOString(),
        guarantees: {
          authoritativeOutcome: true,
          reservesNothing: true,
          createsNothing: true,
          finalExchangeRevalidates: true,
        },
      };
    });
  }

  /** Identical in shape and intent to `QuoteSaleUseCase`'s own — advisory
   * only, read without any lock. Duplicated rather than imported because
   * it is a presentation-only read (two counts and a subtraction), not a
   * rule; the numbers it reports come from the same `stock_balances` row
   * `GET /inventory/balances` reads, so the two can never disagree. */
  private async readAvailability(
    tx: TenantTx,
    businessId: string,
    warehouseId: string,
    items: PreviewExchangeInput['newItems'],
  ) {
    const balances = await tx.stockBalance.findMany({
      where: { businessId, warehouseId, variantId: { in: items.map((i) => i.variantId) } },
      select: { variantId: true, quantityOnHand: true, quantityReserved: true },
    });
    const byVariant = new Map(balances.map((b) => [b.variantId, b]));

    return items.map((item) => {
      const balance = byVariant.get(item.variantId);
      const available = balance ? balance.quantityOnHand.minus(balance.quantityReserved) : new Prisma.Decimal(0);
      return {
        variantId: item.variantId,
        availableQuantity: available.toString(),
        requestedQuantity: new Prisma.Decimal(item.quantity).toString(),
        sufficient: available.greaterThanOrEqualTo(item.quantity),
      };
    });
  }
}
