import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type { CreateSaleInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { resolveAllowNegative } from '../../../inventory/domain/resolve-allow-negative';
import { consumeVariant } from '../../../inventory/domain/consume-variant';
import { documentNumberFromId } from '../../../../common/domain/document-number';
import { assertIdempotentReplayMatches } from '../../../../common/domain/idempotency';
import { findActiveShift } from '../../domain/find-active-shift';
import { computeSaleCost } from '../../domain/sale-cost';
import { AccountingEngineService } from '../../../../engines/accounting/accounting-engine.service';
import { buildSaleJournalLines } from '../../../accounting/domain/sale-journal-lines';
import { round4 } from '../../../../common/domain/money';
import { capManualDiscount } from '../../domain/line-discount';
import { recordCashTransaction } from '../../../finance/domain/record-cash-transaction';
import { TaxEngineService, ResolvedLineTax } from '../../../../engines/tax/tax-engine.service';
import { lockCustomer } from '../../../loyalty/domain/lock-customer';
import { getCustomerPointsBalance } from '../../../loyalty/domain/customer-points-balance';
import { computePointsEarned, resolveLoyaltyEarnRate } from '../../../loyalty/domain/loyalty-earning';
import { allocateRedemption, computeRedemptionValue, resolveLoyaltyRedeemRate } from '../../../loyalty/domain/loyalty-redemption';
import { resolveActivePromotions, combineManualAndPromotion } from '../../../promotions/domain/resolve-promotions';
import { selectBestPromotion, SelectedPromotion } from '../../../promotions/domain/select-best-promotion';

function saleFingerprint(
  warehouseId: string,
  customerId: string | null,
  items: {
    variantId: string;
    quantity: Prisma.Decimal.Value;
    unitPrice: Prisma.Decimal.Value;
    discountAmount: Prisma.Decimal.Value;
    taxExempt?: boolean;
    serials?: string[];
  }[],
  payments: { amount: Prisma.Decimal.Value; method: string }[],
  redeemPoints: Prisma.Decimal.Value | null,
  clientDiscountTotal: Prisma.Decimal.Value,
) {
  return {
    warehouseId,
    customerId,
    // The CLIENT's request only - never a server-resolved value such as
    // the redemption's monetary value or the allocated line discounts.
    // A replay must be judged against what was asked for, not against
    // what the server happened to compute from configuration that may
    // since have changed.
    redeemPoints: redeemPoints === null ? null : new Prisma.Decimal(redeemPoints).toString(),
    // Per-line: only the dimensions loyalty never touches. A line's
    // stored `discountAmount` now includes the server's own redemption
    // allocation, so comparing it against the client's requested discount
    // would make every legitimate replay of a redeeming sale look like a
    // mismatched payload.
    items: items
      .map((i) => ({
        variantId: i.variantId,
        quantity: new Prisma.Decimal(i.quantity).toString(),
        unitPrice: new Prisma.Decimal(i.unitPrice).toString(),
        // Phase 10: the caller no longer supplies tax, so it cannot be part
        // of the fingerprint. The explicit exemption flag IS part of the
        // request, so a replay that flips it is correctly rejected.
        taxExempt: Boolean(i.taxExempt),
        // Phase 8E: serials are CLIENT-supplied, so replaying the same key
        // with a different physical unit must be rejected, not silently
        // accepted. Sorted so the same set in a different order is
        // recognised as the same request.
        serials: [...(i.serials ?? [])].sort(),
      }))
      .sort((a, b) => a.variantId.localeCompare(b.variantId)),
    // The client's own discount total, at sale level. This IS exactly
    // reconstructible from a stored sale (`Sale.discountAmount` minus the
    // REDEEM row's value), whereas the per-line split is not - the
    // allocation is one-way. A replay that changes any line's variant,
    // quantity, price or tax, the redeemed points, or the total discount
    // is still caught; the one thing that would slip through is
    // redistributing an IDENTICAL total discount across identical lines,
    // which changes no monetary outcome of the sale.
    clientDiscountTotal: new Prisma.Decimal(clientDiscountTotal).toString(),
    payments: payments
      .map((p) => ({ amount: new Prisma.Decimal(p.amount).toString(), method: p.method }))
      .sort((a, b) => (a.method + a.amount).localeCompare(b.method + b.amount)),
  };
}

/** Rebuilds "how many points did this sale redeem" from its own REDEEM
 * ledger row, for idempotent-replay comparison. Absent row => none. */
function existingRedeemedPoints(events: { points: Prisma.Decimal }[]): Prisma.Decimal.Value | null {
  if (events.length === 0) return null;
  return events[0].points.negated();
}

/**
 * The Phase-5 equivalent of Purchasing's ReceivePurchaseUseCase: the ONE
 * place a completed Sale is created, and the ONLY place in Sales that
 * touches inventory - exclusively via the tx-accepting `consumeVariant`
 * helper (which itself calls InventoryEngineService.applyMovement),
 * inside the SAME transaction as:
 *   - the Sale/SaleItem insert (the document)
 *   - each line's inventory consumption (movementType SALE, or Bundle
 *     expansion via consumeVariant's existing logic)
 *   - the SalePayment insert(s) for whatever was tendered now
 *   - the CustomerTransaction ledger writes (only if customerId is set)
 * If any step fails, the whole transaction rolls back - there is no
 * window where inventory decreased but the Sale document, payment, or
 * customer ledger didn't, or vice versa (Phase 5 rule #5).
 *
 * Requires the acting user to hold an OPEN Shift for the SAME warehouse
 * being sold from (Phase 5 rule #2's "define and test the invariant"),
 * resolved server-side - never client-supplied, same convention as
 * branchId being derived from warehouseId rather than accepted as input.
 *
 * Lock-ordering (Phase 5 rule #3/#10): SaleItems are processed in
 * variantId order, not client-supplied order, before any StockBalance
 * lock is acquired - see consumeVariant's own doc comment for why this
 * also covers Bundle component ordering.
 */
@Injectable()
export class CreateSaleUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tax: TaxEngineService,
    private readonly engine: InventoryEngineService,
    private readonly effectivePermissions: EffectivePermissionsService,
    private readonly accounting: AccountingEngineService,
  ) {}

  async execute(actor: RequestUser, input: CreateSaleInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.sale.findFirst({
          where: { businessId: actor.tenantId, idempotencyKey: input.idempotencyKey },
          include: { items: true, payments: true },
        });
        // The REDEEM row is the record of what was redeemed - nothing is
        // stored on the Sale itself, so a replay reads it back from the
        // ledger to rebuild the original request's fingerprint.
        const existingEvents = existing
          ? await tx.customerPoints.findMany({
              where: { businessId: actor.tenantId, referenceType: 'Sale', referenceId: existing.id, type: 'REDEEM' },
            })
          : [];
        // Phase 8D: promotions ALSO contribute to `Sale.discountAmount`,
        // so the client's own requested discount is what remains after
        // BOTH server contributions are removed. Without this, every
        // replay of a promoted sale would be misread as a mismatched
        // payload and rejected 409. `discountApplied` is the EFFECTIVE
        // contribution after the BD-11 cap, which is exactly what makes
        // this subtraction exact.
        // Rebuilds each line's sold serials from the append-only link
        // rows, so a replay is compared against what was actually sold.
        const existingSerialsByItem = new Map<string, string[]>();
        if (existing) {
          const links = await tx.saleItemSerial.findMany({
            where: { businessId: actor.tenantId, saleId: existing.id },
            include: { serialNumber: { select: { serial: true } } },
          });
          for (const link of links) {
            const list = existingSerialsByItem.get(link.saleItemId) ?? [];
            list.push(link.serialNumber.serial);
            existingSerialsByItem.set(link.saleItemId, list);
          }
        }
        const existingPromotionDiscount = existing
          ? (
              await tx.salePromotionApplication.findMany({
                where: { businessId: actor.tenantId, saleId: existing.id },
                select: { discountApplied: true },
              })
            ).reduce((sum, a) => sum.plus(a.discountApplied), new Prisma.Decimal(0))
          : new Prisma.Decimal(0);
        if (existing) {
          assertIdempotentReplayMatches(
            saleFingerprint(
              existing.warehouseId,
              existing.customerId,
              existing.items.map((i) => ({ ...i, serials: existingSerialsByItem.get(i.id) ?? [] })),
              existing.payments,
              existingRedeemedPoints(existingEvents),
              // The stored sale discount minus what the server itself
              // contributed (loyalty redemption + promotions) = what the
              // client asked for.
              existing.discountAmount.minus(existingEvents[0]?.basisAmount ?? 0).minus(existingPromotionDiscount),
            ),
            saleFingerprint(
              input.warehouseId,
              input.customerId ?? null,
              input.items,
              input.payments,
              input.redeemPoints ?? null,
              // The CAPPED manual total, because that is what the stored
              // `Sale.discountAmount` reflects after BD-12. Comparing the
              // raw request against a capped stored value would reject
              // every legitimate replay of an over-discounted line.
              input.items.reduce(
                (sum, i) =>
                  sum.plus(capManualDiscount(i.discountAmount, round4(new Prisma.Decimal(i.unitPrice).times(i.quantity)))),
                new Prisma.Decimal(0),
              ),
            ),
          );
          return existing;
        }
      }

      const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId, businessId: actor.tenantId } });
      if (!warehouse) throw new NotFoundDomainError('Warehouse', input.warehouseId);

      const shift = await findActiveShift(tx, actor.tenantId, actor.id);
      if (!shift) throw new ConflictDomainError('An open shift is required to complete a sale');
      if (shift.warehouseId !== input.warehouseId) {
        throw new ValidationFailedError('Your open shift is for a different warehouse - close it and open a new one to sell from this warehouse');
      }

      let customer = null;
      if (input.customerId) {
        // Canonical lock order across the whole system is
        // Customer -> Sale -> StockBalance. The customer row is locked
        // BEFORE any StockBalance lock is taken below, and
        // CreateSaleReturnUseCase takes the same lock before lockSale, so
        // a sale and a return can never form a cycle by grabbing a
        // customer and a stock row in opposite orders.
        //
        // The lock is taken for every customer sale, not only redeeming
        // ones: the loyalty balance is read and written under it, and
        // taking it conditionally would mean two different lock orders
        // depending on the request payload.
        await lockCustomer(tx, actor.tenantId, input.customerId);
        customer = await tx.customer.findFirst({ where: { id: input.customerId, businessId: actor.tenantId } });
        if (!customer) throw new NotFoundDomainError('Customer', input.customerId);
        if (!customer.isActive) throw new ValidationFailedError('Cannot sell to an inactive customer');
      }

      const redeemPoints = new Prisma.Decimal(input.redeemPoints ?? 0);
      if (redeemPoints.greaterThan(0) && !input.customerId) {
        throw new ValidationFailedError('Loyalty points can only be redeemed on a sale attached to a customer', {
          redeemPoints: redeemPoints.toString(),
        });
      }

      const variantIds = input.items.map((i) => i.variantId);
      if (new Set(variantIds).size !== variantIds.length) {
        throw new ValidationFailedError('Duplicate variantId in sale items');
      }
      const variants = await tx.productVariant.findMany({
        where: { id: { in: variantIds }, businessId: actor.tenantId },
        // `product.categoryId` is needed so a CATEGORY-targeted promotion
        // can be matched without a second query per line.
        // Phase 10 (BD-18): the product's own tax and explicit exemption are
        // loaded here so tax resolves from stored configuration, never from
        // anything the caller sent.
        include: { product: { select: { id: true, categoryId: true, tracksSerialNumbers: true, taxId: true, taxExempt: true } } },
      });
      if (variants.length !== variantIds.length) {
        const found = new Set(variants.map((v) => v.id));
        throw new NotFoundDomainError('ProductVariant', variantIds.filter((id) => !found.has(id)).join(', '));
      }

      // ---------------------------------------------------------------
      // Phase 8E / BD-13: serial identity is MANDATORY at sale creation
      // for a serial-tracked variant. Before this, selling such a product
      // recorded no serial at all, so nothing in the system knew which
      // physical unit the customer walked out with - the gap that made
      // warranty registration unverifiable (Known Issue #47).
      //
      // Whether serials are required is decided by the PRODUCT's own
      // tracking flag, never by the request: a client cannot opt out by
      // omitting the field, and cannot smuggle serials onto a line whose
      // product does not track them.
      // ---------------------------------------------------------------
      const variantsById = new Map(variants.map((v) => [v.id, v]));
      for (const item of input.items) {
        const tracks = variantsById.get(item.variantId)!.product.tracksSerialNumbers;
        const supplied = item.serials ?? [];
        if (tracks && supplied.length === 0) {
          throw new ValidationFailedError(
            'This product is serial-tracked - the serial number(s) being sold must be supplied for this line',
            { variantId: item.variantId, quantity: new Prisma.Decimal(item.quantity).toString() },
          );
        }
        if (!tracks && supplied.length > 0) {
          throw new ValidationFailedError('This product is not serial-tracked - serial numbers cannot be supplied for this line', {
            variantId: item.variantId,
          });
        }
        if (tracks && !new Prisma.Decimal(item.quantity).equals(supplied.length)) {
          throw new ValidationFailedError('The number of serials supplied must equal the quantity sold for this line', {
            variantId: item.variantId,
            quantity: new Prisma.Decimal(item.quantity).toString(),
            serialsSupplied: supplied.length,
          });
        }
      }

      // Each line's gross is rounded to the monetary scale BEFORE being
      // summed, so that SUM(line merchandise value) equals
      // `subtotal - discountAmount` exactly. That equality is what lets a
      // full return claw back and restore loyalty exactly (see
      // return-credit.ts). For integer quantities the rounding is the
      // identity, so no pre-existing sale's arithmetic changes; it only
      // bites for fractional quantities at 4-dp prices.
      // ---------------------------------------------------------------
      // Phase 10 (BD-18): TAX, resolved and computed SERVER-SIDE.
      //
      // The request no longer carries `taxAmount` at all - a client cannot
      // state what tax it would like to pay. Everything below derives from
      // the tenant's own tax configuration.
      //
      // In INCLUSIVE mode the unit price and the manual discount arrive
      // expressed in shelf terms and are converted to net HERE, at the line
      // boundary. From this point on the pipeline is byte-identical to
      // EXCLUSIVE mode, which is what keeps BD-1, BD-2, BD-3, BD-11 and
      // BD-12 operating on exactly the values they were approved for.
      // ---------------------------------------------------------------
      const taxCtx = await this.tax.loadContext(tx, actor.tenantId);
      const taxCache = new Map<string, { id: string; ratePercent: Prisma.Decimal; isActive: boolean } | null>();
      const lineTaxByVariant = new Map<string, ResolvedLineTax>();
      const netUnitPrice = new Map<string, Prisma.Decimal>();
      const netManualInput = new Map<string, Prisma.Decimal>();
      for (const item of input.items) {
        const product = variantsById.get(item.variantId)!.product;
        const resolved = await this.tax.resolveLineTax(tx, actor.tenantId, taxCtx, product, item.taxExempt ?? false, taxCache);
        lineTaxByVariant.set(item.variantId, resolved);
        netUnitPrice.set(item.variantId, this.tax.toNet(item.unitPrice, resolved, taxCtx));
        netManualInput.set(item.variantId, this.tax.toNet(item.discountAmount, resolved, taxCtx));
      }

      const lineGross = new Map<string, Prisma.Decimal>();
      // Approved decision BD-12: the manual discount is capped at the
      // line gross UNIVERSALLY, so net merchandise value can never go
      // negative on any line - not only on lines a promotion reached.
      // For a well-formed line this is the identity.
      const cappedManual = new Map<string, Prisma.Decimal>();
      let subtotal = new Prisma.Decimal(0);
      let discountAmount = new Prisma.Decimal(0);
      let taxAmount = new Prisma.Decimal(0);
      for (const item of input.items) {
        const gross = round4(netUnitPrice.get(item.variantId)!.times(item.quantity));
        lineGross.set(item.variantId, gross);
        const manual = capManualDiscount(netManualInput.get(item.variantId)!, gross);
        cappedManual.set(item.variantId, manual);
        subtotal = subtotal.plus(gross);
        discountAmount = discountAmount.plus(manual);
      }
      // `taxAmount` is now computed AFTER every discount is known, once the
      // final net value of each line is settled - see below.

      // ---------------------------------------------------------------
      // Phase 8D: PROMOTIONS, resolved server-side inside this same
      // transaction and BEFORE loyalty (the approved ordering:
      // promotion -> redemption -> earning).
      //
      // The client never supplies promotional pricing: it supplies only
      // its own manual `discountAmount`, and everything below is computed
      // from the promotion rules stored in this tenant.
      //
      // Evaluation is PER LINE (approved decision BD-10) - quantities are
      // never aggregated across variants, products or category lines, so
      // a category "Buy 1 Get 1" over two one-unit lines yields nothing.
      // At most ONE promotion applies per line (best applicable only);
      // different lines may carry different promotions.
      // ---------------------------------------------------------------
      const saleInstant = new Date();
      const activePromotions = await resolveActivePromotions(tx, actor.tenantId, saleInstant);

      const promotionByVariant = new Map<string, SelectedPromotion>();
      const effectivePromotionByVariant = new Map<string, Prisma.Decimal>();
      const cappedByVariant = new Map<string, boolean>();
      const manualDiscountByVariant = new Map<string, Prisma.Decimal>();

      if (activePromotions.length > 0) {
        for (const item of input.items) {
          const variant = variantsById.get(item.variantId)!;
          const gross = lineGross.get(item.variantId)!;
          const best = selectBestPromotion(activePromotions, {
            variantId: item.variantId,
            productId: variant.product.id,
            categoryId: variant.product.categoryId,
            quantity: new Prisma.Decimal(item.quantity),
            unitPrice: new Prisma.Decimal(item.unitPrice),
            lineGross: gross,
          });
          if (!best) continue;

          // Approved decision BD-11: a manual discount and a promotion are
          // ADDITIVE, capped at the line gross. The promotion is computed
          // on the GROSS, never on the post-manual price, and exceeding
          // the gross is capped rather than rejected - the line's net
          // merchandise value can never go negative.
          const manual = cappedManual.get(item.variantId)!;
          const combined = combineManualAndPromotion(manual, best.discount, gross);
          if (combined.effectivePromotionDiscount.lessThanOrEqualTo(0)) {
            // The manual discount already consumed the whole line, so the
            // promotion contributed nothing. No provenance row is written
            // for money that was never given.
            continue;
          }

          promotionByVariant.set(item.variantId, best);
          effectivePromotionByVariant.set(item.variantId, combined.effectivePromotionDiscount);
          cappedByVariant.set(item.variantId, combined.cappedAtLineGross);
          manualDiscountByVariant.set(item.variantId, manual);
          discountAmount = discountAmount.plus(combined.effectivePromotionDiscount);
        }
      }

      // ---------------------------------------------------------------
      // Phase 8C: LOYALTY REDEMPTION, resolved server-side inside this
      // same transaction and BEFORE totals are finalised (approved
      // ordering). Any failure below throws and rolls the whole sale
      // back - there is no committed redemption without a sale.
      // ---------------------------------------------------------------
      const loyaltyDiscountByVariant = new Map<string, Prisma.Decimal>();
      let redemptionValue = new Prisma.Decimal(0);
      let redemptionRate: Prisma.Decimal | null = null;

      if (redeemPoints.greaterThan(0)) {
        redemptionRate = await resolveLoyaltyRedeemRate(tx, actor.tenantId);
        if (!redemptionRate) {
          throw new ValidationFailedError(
            'Loyalty redemption is not configured for this business - no valid redemption rate is set',
            { setting: 'loyalty.currency_per_point' },
          );
        }

        // Balance is read UNDER the customer lock taken above, so two
        // concurrent redemptions cannot each see the same balance and
        // together overspend it.
        const balance = await getCustomerPointsBalance(tx, actor.tenantId, input.customerId!);
        if (redeemPoints.greaterThan(balance)) {
          throw new ConflictDomainError(
            `Cannot redeem ${redeemPoints.toString()} points - the customer's balance is only ${balance.toString()}`,
            { requested: redeemPoints.toString(), balance: balance.toString() },
          );
        }

        redemptionValue = computeRedemptionValue(redeemPoints, redemptionRate);
        if (redemptionValue.lessThanOrEqualTo(0)) {
          // Approved decision: an explicit request to spend points is
          // never silently turned into a no-op that consumes points for
          // nothing. No minimum threshold is invented and the configured
          // rate is not adjusted - the request is simply refused.
          throw new ValidationFailedError(
            'The requested points convert to no monetary value at the configured redemption rate',
            { redeemPoints: redeemPoints.toString(), rate: redemptionRate.toString() },
          );
        }

        const eligibleLines = input.items.map((item) => ({
          variantId: item.variantId,
          // Net of BOTH the manual discount and any promotion already
          // applied - you cannot redeem points against value that has
          // already been discounted away.
          eligible: lineGross
            .get(item.variantId)!
            .minus(cappedManual.get(item.variantId)!)
            .minus(effectivePromotionByVariant.get(item.variantId) ?? 0),
        }));
        const totalEligible = eligibleLines.reduce((sum, l) => sum.plus(l.eligible), new Prisma.Decimal(0));
        if (redemptionValue.greaterThan(totalEligible)) {
          throw new ValidationFailedError(
            `Redemption value ${redemptionValue.toString()} exceeds the sale's remaining merchandise value ${totalEligible.toString()}`,
            { redemptionValue: redemptionValue.toString(), eligible: totalEligible.toString() },
          );
        }

        for (const [variantId, amount] of allocateRedemption(eligibleLines, redemptionValue)) {
          loyaltyDiscountByVariant.set(variantId, amount);
        }
        // Redemption is folded into LINE discounts, never added at sale
        // level, so `Sale.discountAmount = SUM(SaleItem.discountAmount)`
        // still holds and Phase 6's netRevenue keeps working untouched.
        discountAmount = discountAmount.plus(redemptionValue);
      }

      // ---------------------------------------------------------------
      // Phase 10 (BD-18): the tax on each line, computed from the tenant's
      // configuration on the line's FINAL net value - after the manual
      // discount, the promotion and the loyalty redemption. The customer is
      // taxed on what they actually pay.
      //
      // This is the ONE place a tax figure comes into existence for a sale,
      // and it derives entirely from stored configuration.
      // ---------------------------------------------------------------
      const lineTaxAmount = new Map<string, Prisma.Decimal>();
      for (const item of input.items) {
        const lineDiscount = cappedManual
          .get(item.variantId)!
          .plus(effectivePromotionByVariant.get(item.variantId) ?? 0)
          .plus(loyaltyDiscountByVariant.get(item.variantId) ?? 0);
        const netLineValue = lineGross.get(item.variantId)!.minus(lineDiscount);
        const lineTax = this.tax.computeLineTax(netLineValue, lineTaxByVariant.get(item.variantId)!);
        lineTaxAmount.set(item.variantId, lineTax);
        taxAmount = taxAmount.plus(lineTax);
      }

      const totalAmount = subtotal.minus(discountAmount).plus(taxAmount);

      let paidNow = new Prisma.Decimal(0);
      for (const p of input.payments) paidNow = paidNow.plus(p.amount);
      if (paidNow.greaterThan(totalAmount)) {
        throw new ValidationFailedError('Payments exceed the sale total - overpayment/change-due is not tracked, tender the exact amount owed');
      }
      if (!input.customerId && !paidNow.equals(totalAmount)) {
        throw new ValidationFailedError('A walk-in sale (no customer) must be paid in full at the time of sale');
      }

      const id = randomUUID();
      const sale = await tx.sale.create({
        data: {
          id,
          businessId: actor.tenantId,
          branchId: warehouse.branchId,
          warehouseId: input.warehouseId,
          customerId: input.customerId,
          shiftId: shift.id,
          saleNumber: documentNumberFromId('INV', id),
          idempotencyKey: input.idempotencyKey,
          subtotal,
          discountAmount,
          taxAmount,
          totalAmount,
          notes: input.notes,
          createdBy: actor.id,
        },
      });

      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const allowNegative = await resolveAllowNegative(tx, actor.tenantId, permissions ?? new Set());

      // Canonical lock-acquisition order: sorted by variantId, never
      // client-supplied order (Phase 5 rule #3/#10).
      const sortedItems = [...input.items].sort((a, b) => a.variantId.localeCompare(b.variantId));
      for (const item of sortedItems) {
        const lineDiscount = cappedManual
          .get(item.variantId)!
          .plus(effectivePromotionByVariant.get(item.variantId) ?? 0)
          .plus(loyaltyDiscountByVariant.get(item.variantId) ?? 0);
        const resolvedTax = lineTaxByVariant.get(item.variantId)!;
        const lineTax = lineTaxAmount.get(item.variantId)!;
        const lineTotal = lineGross.get(item.variantId)!.minus(lineDiscount).plus(lineTax);

        const createdItem = await tx.saleItem.create({
          data: {
            businessId: actor.tenantId,
            saleId: sale.id,
            variantId: item.variantId,
            quantity: item.quantity,
            // The NET unit price. In EXCLUSIVE mode this is exactly what the
            // caller sent; in INCLUSIVE mode it is the extracted net, so
            // every downstream reader - BD-1 return credit above all - keeps
            // working on tax-exclusive values without knowing which mode the
            // business uses.
            unitPrice: netUnitPrice.get(item.variantId)!,
            discountAmount: lineDiscount,
            // BD-18 rule 4: the applied rate is FROZEN here. Editing,
            // retiring or deleting the Tax row later cannot reach this line.
            taxId: resolvedTax.taxId,
            taxRateSnapshot: resolvedTax.taxId ? resolvedTax.ratePercent : null,
            taxExempt: resolvedTax.exempt,
            taxAmount: lineTax,
            lineTotal,
          },
        });

        // Phase 8D: append-only promotion provenance, written in the SAME
        // transaction as the line it describes. `discountApplied` is the
        // EFFECTIVE contribution after the BD-11 cap - what the promotion
        // actually took off this line - while `ruleSnapshot` carries what
        // the rule COMPUTED plus every parameter it used, so the original
        // arithmetic can be reproduced without ever reading the live
        // Promotion row. The promotion's name and type are frozen here
        // too: renaming a rule later must not rewrite a historical
        // receipt.
        const applied = promotionByVariant.get(item.variantId);
        if (applied) {
          await tx.salePromotionApplication.create({
            data: {
              businessId: actor.tenantId,
              saleId: sale.id,
              saleItemId: createdItem.id,
              promotionId: applied.rule.id,
              promotionType: applied.rule.type,
              promotionName: applied.rule.name,
              ruleSnapshot: {
                ...applied.ruleSnapshot,
                promotionName: applied.rule.name,
                manualDiscountAtSale: (manualDiscountByVariant.get(item.variantId) ?? new Prisma.Decimal(0)).toString(),
                effectiveDiscount: effectivePromotionByVariant.get(item.variantId)!.toString(),
                cappedAtLineGross: cappedByVariant.get(item.variantId) ?? false,
              } as Prisma.InputJsonValue,
              discountApplied: effectivePromotionByVariant.get(item.variantId)!,
            },
          });
        }

        const consumption = await consumeVariant(tx, this.engine, this.audit, {
          businessId: actor.tenantId,
          warehouseId: input.warehouseId,
          variantId: item.variantId,
          quantity: item.quantity,
          movementType: 'SALE',
          referenceType: 'Sale',
          referenceId: sale.id,
          reason: `Sale ${sale.saleNumber}`,
          createdBy: actor.id,
          allowNegative,
          // The units consumed go through InventoryEngine exactly as
          // before - this only tells it WHICH ones.
          serials: item.serials,
        });

        // Phase 8E: the durable link closing Known Issue #47. Append-only
        // and written in the SAME transaction as the movement that
        // consumed the unit, so a serial can never be marked SOLD without
        // the record of which sale line sold it.
        for (const serialNumberId of consumption.consumedSerialIds ?? []) {
          await tx.saleItemSerial.create({
            data: { businessId: actor.tenantId, saleId: sale.id, saleItemId: createdItem.id, serialNumberId },
          });
        }
      }

      for (const p of input.payments) {
        await tx.salePayment.create({
          data: {
            businessId: actor.tenantId,
            saleId: sale.id,
            amount: p.amount,
            method: p.method,
            reference: p.reference,
            receivedBy: actor.id,
          },
        });

        // Phase 10 (BD-17 rule 3): a CASH tender is also a movement of
        // physical money, so it enters the shift's drawer ledger in the
        // SAME transaction as the sale that collected it. That is what
        // makes expected cash derivable and trustworthy - the drawer can
        // never disagree with the documents, because neither can exist
        // without the other.
        //
        // Only CASH. Card, wallet and the rest post to their own clearing
        // accounts and never enter the drawer; including them would
        // overstate expected cash by exactly the card takings.
        if (p.method === 'CASH') {
          await recordCashTransaction(tx, {
            businessId: actor.tenantId,
            shiftId: shift.id,
            type: 'SALE_TENDER',
            amount: p.amount,
            referenceType: 'Sale',
            referenceId: sale.id,
            reason: `Sale ${sale.saleNumber}`,
            createdBy: actor.id,
          });
        }
      }

      // `totalAmount` can legitimately be ZERO once loyalty redemption is
      // allowed to cover the full merchandise value (approved decision
      // BD-7) on a sale with no tax. A zero-amount ledger row carries no
      // information and is rejected outright by the
      // `customer_transactions` non-zero CHECK, so it is skipped - the
      // customer owes nothing and the ledger correctly records nothing.
      // (Latent defect: a 100% MANUAL discount could already reach this
      // before Phase 8C; the same guard now covers both.)
      if (input.customerId && totalAmount.greaterThan(0)) {
        await tx.customerTransaction.create({
          data: {
            businessId: actor.tenantId,
            customerId: input.customerId,
            type: 'SALE',
            amount: totalAmount,
            referenceType: 'Sale',
            referenceId: sale.id,
            description: `Sale ${sale.saleNumber}`,
            createdBy: actor.id,
          },
        });
      }
      if (input.customerId) {
        for (const p of input.payments) {
          await tx.customerTransaction.create({
            data: {
              businessId: actor.tenantId,
              customerId: input.customerId,
              type: 'PAYMENT',
              amount: new Prisma.Decimal(p.amount).negated(),
              referenceType: 'Sale',
              referenceId: sale.id,
              description: `Payment at sale ${sale.saleNumber}`,
              createdBy: actor.id,
            },
          });
        }
      }

      // ---------------------------------------------------------------
      // Phase 8C: LOYALTY LEDGER EVENTS, in the SAME transaction as
      // everything else. Append-only inserts; the partial unique index
      // `customer_points_one_event_per_source` is the database backstop
      // guaranteeing at most one REDEEM and one EARN per Sale, which the
      // Sale's own optional idempotencyKey cannot provide.
      //
      // REDEEM is written before EARN purely for readability - both are
      // in one transaction, and BD-3's ordering requirement is satisfied
      // by the fact that `discountAmount` already includes the
      // redemption before the earning basis is computed below.
      // ---------------------------------------------------------------
      if (input.customerId && redemptionValue.greaterThan(0)) {
        await tx.customerPoints.create({
          data: {
            businessId: actor.tenantId,
            customerId: input.customerId,
            type: 'REDEEM',
            points: redeemPoints.negated(),
            // Note the direction, opposite to EARN's: for a REDEEM row
            // `basisAmount = round4(|points| x rateSnapshot)`, so the row
            // reproduces its own arithmetic from its own fields with no
            // current configuration consulted.
            basisAmount: redemptionValue,
            rateSnapshot: redemptionRate!,
            referenceType: 'Sale',
            referenceId: sale.id,
            description: `Redeemed on sale ${sale.saleNumber}`,
            createdBy: actor.id,
          },
        });
      }

      // BD-3: the earning basis is the NET merchandise amount - after
      // every discount INCLUDING the loyalty redemption just applied -
      // and before tax.
      const loyaltyEligibleAmount = subtotal.minus(discountAmount);
      if (input.customerId) {
        const earnRate = await resolveLoyaltyEarnRate(tx, actor.tenantId);
        if (earnRate) {
          const pointsEarned = computePointsEarned(loyaltyEligibleAmount, earnRate);
          // A zero result records nothing: it carries no information, and
          // `customer_points_nonzero` would reject the row anyway.
          if (pointsEarned.greaterThan(0)) {
            await tx.customerPoints.create({
              data: {
                businessId: actor.tenantId,
                customerId: input.customerId,
                type: 'EARN',
                points: pointsEarned,
                basisAmount: loyaltyEligibleAmount,
                rateSnapshot: earnRate,
                referenceType: 'Sale',
                referenceId: sale.id,
                description: `Earned on sale ${sale.saleNumber}`,
                createdBy: actor.id,
              },
            });
          }
        }
      }

      // Phase 6: post the accounting fact for this Sale in the SAME
      // transaction - COGS sourced exclusively from computeSaleCost,
      // which reads the SALE/BUNDLE_CONSUMPTION StockMovement rows
      // consumeVariant just wrote above (unit_cost_at_movement, never a
      // recomputed/current cost). Nothing here duplicates Sales'
      // business logic - the lines are built from values already
      // computed by this exact use-case (subtotal/discountAmount/
      // taxAmount/totalAmount/payments).
      const { totalCost } = await computeSaleCost(tx, actor.tenantId, { id: sale.id, subtotal, discountAmount });
      const journalLines = await buildSaleJournalLines(tx, actor.tenantId, {
        subtotal,
        discountAmount,
        taxAmount,
        totalAmount,
        totalCost,
        payments: input.payments,
      });
      if (journalLines.length > 0) {
        await this.accounting.postEntry(tx, {
          businessId: actor.tenantId,
          entryDate: new Date(),
          sourceType: 'Sale',
          sourceId: sale.id,
          description: `Sale ${sale.saleNumber}`,
          createdBy: actor.id,
          lines: journalLines,
        });
      }

      const finalSale = await tx.sale.findUniqueOrThrow({ where: { id: sale.id }, include: { items: true, payments: true } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Sale',
        entityId: sale.id,
        after: finalSale,
      });

      return finalSale;
    });
  }
}
