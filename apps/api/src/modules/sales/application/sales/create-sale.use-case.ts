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
import { lockCustomer } from '../../../loyalty/domain/lock-customer';
import { getCustomerPointsBalance } from '../../../loyalty/domain/customer-points-balance';
import { computePointsEarned, resolveLoyaltyEarnRate } from '../../../loyalty/domain/loyalty-earning';
import { allocateRedemption, computeRedemptionValue, resolveLoyaltyRedeemRate } from '../../../loyalty/domain/loyalty-redemption';

function saleFingerprint(
  warehouseId: string,
  customerId: string | null,
  items: { variantId: string; quantity: Prisma.Decimal.Value; unitPrice: Prisma.Decimal.Value; discountAmount: Prisma.Decimal.Value; taxAmount: Prisma.Decimal.Value }[],
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
        taxAmount: new Prisma.Decimal(i.taxAmount).toString(),
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
        if (existing) {
          assertIdempotentReplayMatches(
            saleFingerprint(
              existing.warehouseId,
              existing.customerId,
              existing.items,
              existing.payments,
              existingRedeemedPoints(existingEvents),
              // The stored sale discount minus what the server itself
              // contributed = what the client asked for.
              existing.discountAmount.minus(existingEvents[0]?.basisAmount ?? 0),
            ),
            saleFingerprint(
              input.warehouseId,
              input.customerId ?? null,
              input.items,
              input.payments,
              input.redeemPoints ?? null,
              input.items.reduce((sum, i) => sum.plus(i.discountAmount), new Prisma.Decimal(0)),
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
      const variants = await tx.productVariant.findMany({ where: { id: { in: variantIds }, businessId: actor.tenantId } });
      if (variants.length !== variantIds.length) {
        const found = new Set(variants.map((v) => v.id));
        throw new NotFoundDomainError('ProductVariant', variantIds.filter((id) => !found.has(id)).join(', '));
      }

      // Each line's gross is rounded to the monetary scale BEFORE being
      // summed, so that SUM(line merchandise value) equals
      // `subtotal - discountAmount` exactly. That equality is what lets a
      // full return claw back and restore loyalty exactly (see
      // return-credit.ts). For integer quantities the rounding is the
      // identity, so no pre-existing sale's arithmetic changes; it only
      // bites for fractional quantities at 4-dp prices.
      const lineGross = new Map<string, Prisma.Decimal>();
      let subtotal = new Prisma.Decimal(0);
      let discountAmount = new Prisma.Decimal(0);
      let taxAmount = new Prisma.Decimal(0);
      for (const item of input.items) {
        const gross = round4(new Prisma.Decimal(item.unitPrice).times(item.quantity));
        lineGross.set(item.variantId, gross);
        subtotal = subtotal.plus(gross);
        discountAmount = discountAmount.plus(item.discountAmount);
        taxAmount = taxAmount.plus(item.taxAmount);
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
          eligible: lineGross.get(item.variantId)!.minus(item.discountAmount),
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
        const lineDiscount = new Prisma.Decimal(item.discountAmount).plus(
          loyaltyDiscountByVariant.get(item.variantId) ?? 0,
        );
        const lineTotal = lineGross.get(item.variantId)!.minus(lineDiscount).plus(item.taxAmount);

        await tx.saleItem.create({
          data: {
            businessId: actor.tenantId,
            saleId: sale.id,
            variantId: item.variantId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            discountAmount: lineDiscount,
            taxAmount: item.taxAmount,
            lineTotal,
          },
        });

        await consumeVariant(tx, this.engine, this.audit, {
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
        });
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
