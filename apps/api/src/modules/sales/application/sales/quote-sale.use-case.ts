import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { QuoteSaleInput } from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { round4 } from '../../../../common/domain/money';
import { CreateSaleUseCase } from './create-sale.use-case';

/**
 * Phase 12 — THE AUTHORITATIVE TOTAL, BEFORE THE MONEY.
 *
 * `POST /sales` requires the tender to equal the sale total exactly, and
 * the total is only knowable after tax, promotions and loyalty have been
 * resolved from the tenant's own configuration. A till therefore could not
 * tell a customer what to pay: the POS priced the cart itself, guessed,
 * and the server rejected the sale whenever the guess was wrong. That is
 * the gap this closes.
 *
 * HOW IT AVOIDS BEING A SECOND PRICING ENGINE. It does not compute
 * anything. It calls `CreateSaleUseCase.quotePricing`, which is the SAME
 * private pipeline `executeInTx` runs before it writes a single row - the
 * same BD-18 tax resolution, the same BD-12 cap, the same BD-10/BD-11
 * promotion selection, the same BD-2/BD-3 redemption, in the same approved
 * order. There is one implementation of that arithmetic in the product and
 * both callers run it. Two implementations agreeing by inspection is
 * exactly what a quote must not be.
 *
 * HOW SIDE-EFFECT FREEDOM IS GUARANTEED. Not by inspection either. The
 * whole thing runs inside `withTenantReadOnly`, a transaction PostgreSQL
 * has been told is READ ONLY, so any INSERT, UPDATE, DELETE or
 * `SELECT ... FOR UPDATE` reaching it - today or after some future edit to
 * the shared pipeline - fails at the database. No Sale, no journal entry,
 * no stock movement, no loyalty row, no promotion application, no serial
 * transition, no cash transaction, no customer transaction can be created
 * from this path.
 *
 * WHAT A QUOTE IS NOT. It is not a reservation and it is not a promise.
 * Stock, prices, promotions, tax configuration and the customer's point
 * balance may all change between the quote and the sale, and nothing here
 * holds any of them. `POST /sales` re-resolves every one of them inside
 * its own transaction, under the locks it has always taken, and remains
 * the only authority. A quote whose conditions have moved simply produces
 * a sale that is refused or priced differently - which is the honest
 * outcome, and why the response says so in `guarantees`.
 */
@Injectable()
export class QuoteSaleUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly createSale: CreateSaleUseCase,
  ) {}

  async execute(actor: RequestUser, input: QuoteSaleInput) {
    return this.prisma.withTenantReadOnly(actor.tenantId, async (tx) => {
      // The same request shape the sale is given, with the fields a quote
      // must not carry left at their neutral values. `payments` is empty
      // because the exact-payment rule is checked on the write path only -
      // the quote exists precisely to tell the caller what to put there.
      const priced = await this.createSale.quotePricing(tx, actor, {
        warehouseId: input.warehouseId,
        customerId: input.customerId,
        items: input.items,
        redeemPoints: input.redeemPoints,
        payments: [],
      });

      const lines = input.items.map((item) => {
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
          // The NET unit price. In INCLUSIVE mode this is the extracted
          // net, exactly as the sale will store it - so a receipt printed
          // later shows the number the quote showed.
          unitPrice: priced.netUnitPrice.get(item.variantId)!.toString(),
          lineGross: gross.toString(),
          manualDiscount: manual.toString(),
          promotionDiscount: promotion.toString(),
          loyaltyDiscount: loyalty.toString(),
          discountAmount: round4(manual.plus(promotion).plus(loyalty)).toString(),
          taxId: resolvedTax.taxId,
          taxRatePercent: resolvedTax.taxId ? resolvedTax.ratePercent.toString() : null,
          taxExempt: resolvedTax.exempt,
          taxAmount: tax.toString(),
          lineTotal: round4(gross.minus(manual).minus(promotion).minus(loyalty).plus(tax)).toString(),
          // Named, because "why is this line cheaper?" is the question a
          // cashier is asked at the counter. The name is the live rule's;
          // the sale freezes its own copy when it writes provenance.
          promotion: applied ? { id: applied.rule.id, name: applied.rule.name, type: applied.rule.type } : null,
          // Serial capture is decided by the product, never the request.
          // Surfacing it here lets the till prompt before payment rather
          // than discover it at commit.
          requiresSerials: variant.product.tracksSerialNumbers,
        };
      });

      // Advisory only, and labelled as such. Stock is authoritative at
      // commit, under the row lock the inventory engine takes; reporting
      // it here lets a cashier see a problem before taking money without
      // pretending anything is held.
      const availability = await this.readAvailability(tx, actor.tenantId, input.warehouseId, input.items);

      return {
        warehouseId: input.warehouseId,
        customerId: input.customerId ?? null,
        currency: (await tx.business.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { currency: true } }))
          .currency,
        lines,
        totals: {
          subtotal: priced.subtotal.toString(),
          discountAmount: priced.discountAmount.toString(),
          taxAmount: priced.taxAmount.toString(),
          // THE FIGURE THE TILL EXISTS TO GET. Tender exactly this on
          // `POST /sales` and the exact-payment rule is satisfied.
          totalAmount: priced.totalAmount.toString(),
          amountDue: priced.totalAmount.toString(),
        },
        loyalty: {
          pointsRequested: new Prisma.Decimal(input.redeemPoints ?? 0).toString(),
          redemptionValue: priced.redemptionValue.toString(),
          redemptionRate: priced.redemptionRate ? priced.redemptionRate.toString() : null,
        },
        availability,
        quotedAt: new Date().toISOString(),
        guarantees: {
          /**
           * Stated in the payload rather than only in documentation,
           * because a client that reads the total is the client that needs
           * to know what it is not being told.
           */
          authoritativePricing: true,
          reservesStock: false,
          holdsPrices: false,
          holdsPromotions: false,
          holdsLoyaltyBalance: false,
          createsNothing: true,
        },
      };
    });
  }

  /**
   * Per-line available quantity, read without any lock. `availableQuantity`
   * is on-hand minus the advisory reservation, matching what
   * `GET /inventory/balances` reports, so the two never disagree.
   */
  private async readAvailability(
    tx: TenantTx,
    businessId: string,
    warehouseId: string,
    items: QuoteSaleInput['items'],
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
        // A hint, not a verdict: whether the sale is actually allowed to
        // go negative depends on `inventory.allow_negative_stock` and the
        // caller's permission, both resolved at commit.
        sufficient: available.greaterThanOrEqualTo(item.quantity),
      };
    });
  }
}
