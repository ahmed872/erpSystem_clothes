import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type { CreateSaleReturnInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { resolveAllowNegative } from '../../../inventory/domain/resolve-allow-negative';
import { lockSale } from '../../domain/lock-sale';
import { documentNumberFromId } from '../../../../common/domain/document-number';
import { assertIdempotentReplayMatches } from '../../../../common/domain/idempotency';
import { AccountingEngineService } from '../../../../engines/accounting/accounting-engine.service';
import { buildSaleReturnJournalLines } from '../../../accounting/domain/sale-return-journal-lines';
import { lineReturnCredit, saleCumulativeReturnCredit } from '../../domain/return-credit';
import { lockCustomer } from '../../../loyalty/domain/lock-customer';
import { getCustomerPointsBalance } from '../../../loyalty/domain/customer-points-balance';
import { computeCumulativeClawback, computeCumulativeRestoration } from '../../../loyalty/domain/loyalty-returns';

function saleReturnFingerprint(saleId: string, items: { saleItemId: string; quantity: Prisma.Decimal.Value; condition: string }[]) {
  return {
    saleId,
    items: items
      .map((i) => ({ saleItemId: i.saleItemId, quantity: new Prisma.Decimal(i.quantity).toString(), condition: i.condition }))
      .sort((a, b) => a.saleItemId.localeCompare(b.saleItemId)),
  };
}

/**
 * A sale return is a single-step atomic action (not a draft/confirm
 * workflow), mirroring PurchaseReturn - but WITH idempotencyKey from day
 * one, correcting Known Issue #23 rather than reproducing it.
 *
 * Returnable quantity rule: bounded by `SaleItem.quantity -
 * SaleItem.quantityReturned` per line, protected under the SAME
 * Sale-row lock CreateSalePaymentUseCase uses, so two concurrent returns
 * against the same line can never together over-return it.
 *
 * SELLABLE condition: posts a real SALES_RETURN increase, costed at the
 * ORIGINAL sale's own unit_cost_at_movement (looked up from that
 * specific StockMovement, carried over exactly - never fabricated or
 * defaulted to today's average cost, the same non-fabrication principle
 * Stock Transfers use). DAMAGED condition: the same SALES_RETURN
 * increase is posted (the goods DID physically come back), immediately
 * followed by a DAMAGE decrease of the same quantity at the engine's
 * current average cost (standard decrease-costing rule, zero
 * special-casing) - net stock effect zero, but both real events stay
 * visible in the ledger. The customer credit is posted identically
 * regardless of condition - a damaged return is the store's inventory
 * loss to absorb, not the customer's.
 *
 * Bundle-type SaleItems cannot be returned in v1 (see Known Issues) -
 * rejected explicitly rather than silently mishandled.
 */
@Injectable()
export class CreateSaleReturnUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngineService,
    private readonly effectivePermissions: EffectivePermissionsService,
    private readonly accounting: AccountingEngineService,
  ) {}

  async execute(actor: RequestUser, saleId: string, input: CreateSaleReturnInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.saleReturn.findFirst({
          where: { businessId: actor.tenantId, idempotencyKey: input.idempotencyKey },
          include: { items: true },
        });
        if (existing) {
          assertIdempotentReplayMatches(
            saleReturnFingerprint(existing.saleId, existing.items),
            saleReturnFingerprint(saleId, input.items),
          );
          return existing;
        }
      }

      // Canonical lock order across the whole system is
      // Customer -> Sale -> StockBalance. The customer must be locked
      // BEFORE the sale (and therefore before any StockBalance lock taken
      // by applyMovement below), because CreateSaleUseCase locks the
      // customer before its own stock locks - the opposite order here
      // would let a concurrent sale and return deadlock on
      // customer-vs-stock. Resolved with a cheap unlocked read first,
      // since the sale row is what tells us who the customer is.
      const saleOwner = await tx.sale.findFirst({
        where: { id: saleId, businessId: actor.tenantId },
        select: { customerId: true },
      });
      if (!saleOwner) throw new NotFoundDomainError('Sale', saleId);
      if (saleOwner.customerId) {
        await lockCustomer(tx, actor.tenantId, saleOwner.customerId);
      }

      await lockSale(tx, actor.tenantId, saleId);
      const sale = await tx.sale.findFirst({
        where: { id: saleId, businessId: actor.tenantId },
        include: { items: { include: { variant: { include: { product: true } } } } },
      });
      if (!sale) throw new NotFoundDomainError('Sale', saleId);

      const itemIds = input.items.map((i) => i.saleItemId);
      if (new Set(itemIds).size !== itemIds.length) {
        throw new ValidationFailedError('Duplicate saleItemId in return request');
      }
      const itemsById = new Map(sale.items.map((i) => [i.id, i]));
      for (const line of input.items) {
        const saleItem = itemsById.get(line.saleItemId);
        if (!saleItem) throw new NotFoundDomainError('SaleItem', line.saleItemId);
        if (saleItem.variant.product.type === 'BUNDLE') {
          throw new ValidationFailedError('Bundle sale items cannot be returned - return the individual components instead', {
            saleItemId: saleItem.id,
          });
        }

        const available = saleItem.quantity.minus(saleItem.quantityReturned);
        if (new Prisma.Decimal(line.quantity).greaterThan(available)) {
          throw new ConflictDomainError(
            `Cannot return ${line.quantity} of variant ${saleItem.variantId} - only ${available.toString()} is available to return`,
            { saleItemId: saleItem.id, available: available.toString(), requested: line.quantity },
          );
        }
      }

      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const allowNegative = await resolveAllowNegative(tx, actor.tenantId, permissions ?? new Set());

      const returnId = randomUUID();
      const saleReturn = await tx.saleReturn.create({
        data: {
          id: returnId,
          businessId: actor.tenantId,
          saleId,
          warehouseId: sale.warehouseId,
          returnNumber: documentNumberFromId('SRET', returnId),
          idempotencyKey: input.idempotencyKey,
          reason: input.reason,
          createdBy: actor.id,
        },
      });

      let totalCredit = new Prisma.Decimal(0);
      let returnInCost = new Prisma.Decimal(0);
      let damageWriteOff = new Prisma.Decimal(0);
      for (const line of input.items) {
        const saleItem = itemsById.get(line.saleItemId)!;

        const originalMovement = await tx.stockMovement.findFirst({
          where: { businessId: actor.tenantId, referenceType: 'Sale', referenceId: saleId, variantId: saleItem.variantId, movementType: 'SALE' },
        });
        if (!originalMovement) {
          throw new ValidationFailedError('No original sale movement found for this line - sale data is inconsistent', {
            saleItemId: saleItem.id,
          });
        }

        await this.engine.applyMovement(tx, {
          businessId: actor.tenantId,
          branchId: sale.branchId,
          warehouseId: sale.warehouseId,
          variantId: saleItem.variantId,
          quantityDelta: line.quantity,
          movementType: 'SALES_RETURN',
          unitCostOverride: originalMovement.unitCostAtMovement,
          referenceType: 'SaleReturn',
          referenceId: saleReturn.id,
          reason: input.reason ?? `Sale return against ${sale.saleNumber}`,
          createdBy: actor.id,
          allowNegative,
        });
        returnInCost = returnInCost.plus(new Prisma.Decimal(line.quantity).times(originalMovement.unitCostAtMovement));

        if (line.condition === 'DAMAGED') {
          const damageResult = await this.engine.applyMovement(tx, {
            businessId: actor.tenantId,
            branchId: sale.branchId,
            warehouseId: sale.warehouseId,
            variantId: saleItem.variantId,
            quantityDelta: new Prisma.Decimal(line.quantity).negated(),
            movementType: 'DAMAGE',
            referenceType: 'SaleReturn',
            referenceId: saleReturn.id,
            reason: 'Returned item damaged - written off, not returned to sellable stock',
            createdBy: actor.id,
            allowNegative,
          });
          damageWriteOff = damageWriteOff.plus(new Prisma.Decimal(line.quantity).times(damageResult.movement.unitCostAtMovement));
        }

        await tx.saleReturnItem.create({
          data: {
            businessId: actor.tenantId,
            saleReturnId: saleReturn.id,
            saleItemId: saleItem.id,
            variantId: saleItem.variantId,
            quantity: line.quantity,
            unitPrice: saleItem.unitPrice,
            condition: line.condition,
          },
        });

        await tx.saleItem.update({
          where: { id: saleItem.id },
          data: { quantityReturned: saleItem.quantityReturned.plus(line.quantity) },
        });

        // BD-1: the credit is the line's HISTORICAL merchandise value
        // apportioned by cumulative returned quantity - NOT
        // `quantity x unitPrice`, which ignored `discountAmount` and
        // over-refunded every discounted line (a Buy-2-Get-1 line paid
        // 200 refunded 300). The single shared definition in
        // return-credit.ts is used by the refund, the loyalty clawback
        // and the redemption restoration alike, so no two of them can
        // ever disagree about how much of the sale came back.
        totalCredit = totalCredit.plus(lineReturnCredit(saleItem, line.quantity));
      }

      // ---------------------------------------------------------------
      // Phase 8C: LOYALTY CONSEQUENCES OF THE RETURN, in this same
      // transaction. Both are CUMULATIVE-DELTA calculations driven by the
      // SAME return credit the refund above uses, so a sequence of
      // partial returns telescopes to exactly the original amounts
      // instead of accumulating rounding drift.
      //
      // Every input is a historical snapshot - the original EARN/REDEEM
      // rows' own points/basisAmount/rateSnapshot plus the Sale's own
      // immutable subtotal/discountAmount. Current loyalty settings are
      // never read, so a rate changed after the sale cannot alter what is
      // clawed back or restored.
      //
      // Nothing here mutates or deletes a historical ledger row: both are
      // new compensating INSERTs, and `erp_app` holds no UPDATE or DELETE
      // privilege on customer_points to do otherwise.
      // ---------------------------------------------------------------
      if (sale.customerId) {
        // Re-read the lines AFTER this return's quantityReturned updates
        // above, so `C` is the sale's cumulative position including this
        // return.
        const linesAfter = await tx.saleItem.findMany({ where: { saleId: sale.id, businessId: actor.tenantId } });
        const cumulativeCredit = saleCumulativeReturnCredit(linesAfter);
        const saleMerchandiseAmount = sale.subtotal.minus(sale.discountAmount);

        const loyaltyEvents = await tx.customerPoints.findMany({
          where: { businessId: actor.tenantId, customerId: sale.customerId, referenceType: 'Sale', referenceId: sale.id },
        });
        const priorReturns = await tx.customerPoints.findMany({
          where: {
            businessId: actor.tenantId,
            customerId: sale.customerId,
            referenceType: 'SaleReturn',
            referenceId: { in: (await tx.saleReturn.findMany({ where: { saleId: sale.id, businessId: actor.tenantId }, select: { id: true } })).map((r) => r.id) },
          },
        });

        // BD-8: restore the customer's own spent points, proportionally
        // and cumulatively. Written BEFORE the clawback so the balance
        // assertion at the end sees the return's true net effect.
        const redeemRow = loyaltyEvents.find((e) => e.type === 'REDEEM');
        if (redeemRow && redeemRow.basisAmount) {
          const alreadyRestoredPoints = priorReturns
            .filter((e) => e.type === 'REDEMPTION_RESTORATION')
            .reduce((sum, e) => sum.plus(e.points), new Prisma.Decimal(0));
          const alreadyRestoredValue = priorReturns
            .filter((e) => e.type === 'REDEMPTION_RESTORATION')
            .reduce((sum, e) => sum.plus(e.basisAmount ?? 0), new Prisma.Decimal(0));

          const restoration = computeCumulativeRestoration(
            redeemRow.points.negated(),
            redeemRow.basisAmount,
            saleMerchandiseAmount,
            cumulativeCredit,
            alreadyRestoredPoints,
            alreadyRestoredValue,
          );
          if (restoration.points.greaterThan(0)) {
            await tx.customerPoints.create({
              data: {
                businessId: actor.tenantId,
                customerId: sale.customerId,
                type: 'REDEMPTION_RESTORATION',
                points: restoration.points,
                basisAmount: restoration.value,
                // The ORIGINAL rate, never today's - this row records what
                // those points were worth when they were spent.
                rateSnapshot: redeemRow.rateSnapshot,
                referenceType: 'SaleReturn',
                referenceId: saleReturn.id,
                description: `Redeemed points restored on return ${saleReturn.returnNumber}`,
                createdBy: actor.id,
              },
            });
          }
        }

        // Approved rule 6.2: claw back the points earned on the portion
        // of the sale that came back, using the ORIGINAL earning basis
        // and rate snapshot.
        const earnRow = loyaltyEvents.find((e) => e.type === 'EARN');
        if (earnRow && earnRow.basisAmount && earnRow.rateSnapshot) {
          const alreadyClawedBack = priorReturns
            .filter((e) => e.type === 'RETURN_CLAWBACK')
            .reduce((sum, e) => sum.plus(e.points.negated()), new Prisma.Decimal(0));

          const clawback = computeCumulativeClawback(
            earnRow.points,
            earnRow.basisAmount,
            earnRow.rateSnapshot,
            cumulativeCredit,
            alreadyClawedBack,
          );
          if (clawback.greaterThan(0)) {
            await tx.customerPoints.create({
              data: {
                businessId: actor.tenantId,
                customerId: sale.customerId,
                type: 'RETURN_CLAWBACK',
                points: clawback.negated(),
                basisAmount: totalCredit,
                rateSnapshot: earnRow.rateSnapshot,
                referenceType: 'SaleReturn',
                referenceId: saleReturn.id,
                description: `Points clawed back on return ${saleReturn.returnNumber}`,
                createdBy: actor.id,
              },
            });
          }
        }

        // The approved rule forbids a negative loyalty balance. The check
        // is made on the balance the return actually LEAVES BEHIND -
        // after both the restoration and the clawback - because the two
        // are effects of one atomic return. Checking the clawback alone
        // would reject returns that are in fact fully funded by their own
        // restoration. If it fails, the ENTIRE return is rejected: no
        // refund, no stock movement, no journal entry, no ledger row.
        const finalBalance = await getCustomerPointsBalance(tx, actor.tenantId, sale.customerId);
        if (finalBalance.lessThan(0)) {
          throw new ConflictDomainError(
            'This return cannot be processed: the loyalty points earned on this sale have already been spent, and clawing them back would leave a negative balance',
            { customerId: sale.customerId, resultingBalance: finalBalance.toString() },
          );
        }
      }

      if (sale.customerId && totalCredit.greaterThan(0)) {
        await tx.customerTransaction.create({
          data: {
            businessId: actor.tenantId,
            customerId: sale.customerId,
            type: 'SALE_RETURN',
            amount: totalCredit.negated(),
            referenceType: 'SaleReturn',
            referenceId: saleReturn.id,
            description: `Sale return credit against ${sale.saleNumber}`,
            createdBy: actor.id,
          },
        });
      }

      // Phase 6: post the accounting fact for this return in the SAME
      // transaction - see buildSaleReturnJournalLines's doc comment for
      // the walk-in-return revenue-reversal limitation.
      const returnJournalLines = await buildSaleReturnJournalLines(tx, actor.tenantId, {
        customerId: sale.customerId,
        totalCredit,
        returnInCost,
        damageWriteOff,
      });
      if (returnJournalLines.length > 0) {
        await this.accounting.postEntry(tx, {
          businessId: actor.tenantId,
          entryDate: new Date(),
          sourceType: 'SaleReturn',
          sourceId: saleReturn.id,
          description: `Sale return ${saleReturn.returnNumber}`,
          createdBy: actor.id,
          lines: returnJournalLines,
        });
      }

      const finalReturn = await tx.saleReturn.findUniqueOrThrow({ where: { id: saleReturn.id }, include: { items: true } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'SaleReturn',
        entityId: saleReturn.id,
        after: finalReturn,
        reason: input.reason ?? 'Sale return',
      });

      return finalReturn;
    });
  }
}
