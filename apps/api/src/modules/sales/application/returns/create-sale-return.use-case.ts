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

        totalCredit = totalCredit.plus(new Prisma.Decimal(line.quantity).times(saleItem.unitPrice));
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
