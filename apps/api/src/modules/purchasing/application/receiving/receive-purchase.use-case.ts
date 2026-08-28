import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type { ReceivePurchaseInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { lockPurchase } from '../../domain/lock-purchase';
import { documentNumberFromId } from '../../domain/document-number';

const RECEIVABLE_STATUSES = new Set(['APPROVED', 'PARTIALLY_RECEIVED']);

/**
 * The "Receiving" responsibility - deliberately separate from the
 * Purchase document itself. This is the ONLY place in Purchasing that
 * touches inventory, and it does so exclusively through
 * InventoryEngineService.applyMovement (never a direct stock_balances/
 * stock_movements write), inside the SAME transaction as:
 *   - the PurchaseReceipt/PurchaseReceiptItem insert (the event record)
 *   - the PurchaseItem.quantityReceived increment (the document-level
 *     running total, guarded by the Purchase-row lock below)
 *   - the SupplierTransaction(PURCHASE) ledger write (the payable increase)
 *   - the Purchase.status transition (PARTIALLY_RECEIVED / RECEIVED)
 * If any step fails, the whole transaction rolls back - there is no
 * window where inventory increased but the purchase document or supplier
 * ledger didn't, or vice versa.
 *
 * Supports partial receiving (not all ordered quantity need arrive at
 * once) and multiple receiving operations against the same Purchase
 * (call this again for the remainder). Over-receiving is rejected by
 * comparing against `quantityOrdered - quantityReceived` computed from
 * the Purchase row locked by lockPurchase - the same lock that makes two
 * concurrent receive calls for the same Purchase serialize, so the
 * second call always sees the first one's already-applied increment
 * before deciding how much is still receivable.
 */
@Injectable()
export class ReceivePurchaseUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngineService,
  ) {}

  async execute(actor: RequestUser, purchaseId: string, input: ReceivePurchaseInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.purchaseReceipt.findFirst({
          where: { businessId: actor.tenantId, idempotencyKey: input.idempotencyKey },
          include: { items: true },
        });
        if (existing) return existing;
      }

      await lockPurchase(tx, actor.tenantId, purchaseId);
      const purchase = await tx.purchase.findFirst({
        where: { id: purchaseId, businessId: actor.tenantId },
        include: { items: true, warehouse: true },
      });
      if (!purchase) throw new NotFoundDomainError('Purchase', purchaseId);
      if (!RECEIVABLE_STATUSES.has(purchase.status)) {
        throw new ConflictDomainError(`Purchase cannot be received from its current status: ${purchase.status}`);
      }

      const itemIds = input.items.map((i) => i.purchaseItemId);
      if (new Set(itemIds).size !== itemIds.length) {
        throw new ValidationFailedError('Duplicate purchaseItemId in receiving request');
      }
      const itemsById = new Map(purchase.items.map((i) => [i.id, i]));
      for (const line of input.items) {
        const purchaseItem = itemsById.get(line.purchaseItemId);
        if (!purchaseItem) throw new NotFoundDomainError('PurchaseItem', line.purchaseItemId);

        const remaining = purchaseItem.quantityOrdered.minus(purchaseItem.quantityReceived);
        if (new Prisma.Decimal(line.quantityReceived).greaterThan(remaining)) {
          throw new ConflictDomainError(
            `Cannot receive ${line.quantityReceived} of variant ${purchaseItem.variantId} - only ${remaining.toString()} remains outstanding on this purchase`,
            { purchaseItemId: purchaseItem.id, remaining: remaining.toString(), requested: line.quantityReceived },
          );
        }
      }

      const receiptId = randomUUID();
      const receipt = await tx.purchaseReceipt.create({
        data: {
          id: receiptId,
          businessId: actor.tenantId,
          purchaseId,
          warehouseId: purchase.warehouseId,
          // purchase_receipts is append-only at the DB privilege level
          // (SELECT+INSERT only, no UPDATE) - the receipt number is
          // therefore computed from the client-generated id up front,
          // never filled in with a follow-up update.
          receiptNumber: documentNumberFromId('GRN', receiptId),
          idempotencyKey: input.idempotencyKey,
          notes: input.notes,
          receivedBy: actor.id,
        },
      });

      let totalReceivedValue = new Prisma.Decimal(0);
      for (const line of input.items) {
        const purchaseItem = itemsById.get(line.purchaseItemId)!;

        await this.engine.applyMovement(tx, {
          businessId: actor.tenantId,
          branchId: purchase.branchId,
          warehouseId: purchase.warehouseId,
          variantId: purchaseItem.variantId,
          quantityDelta: line.quantityReceived,
          movementType: 'PURCHASE',
          unitCostOverride: purchaseItem.unitCost,
          referenceType: 'PurchaseReceipt',
          referenceId: receipt.id,
          reason: `Goods receipt against purchase ${purchase.purchaseNumber}`,
          createdBy: actor.id,
          // Receiving is always an increase - allowNegative only governs
          // decreases going negative, so it has no effect here.
          allowNegative: false,
        });

        await tx.purchaseReceiptItem.create({
          data: {
            businessId: actor.tenantId,
            purchaseReceiptId: receipt.id,
            purchaseItemId: purchaseItem.id,
            variantId: purchaseItem.variantId,
            quantityReceived: line.quantityReceived,
            unitCost: purchaseItem.unitCost,
          },
        });

        await tx.purchaseItem.update({
          where: { id: purchaseItem.id },
          data: { quantityReceived: purchaseItem.quantityReceived.plus(line.quantityReceived) },
        });

        totalReceivedValue = totalReceivedValue.plus(new Prisma.Decimal(line.quantityReceived).times(purchaseItem.unitCost));
      }

      if (totalReceivedValue.greaterThan(0)) {
        await tx.supplierTransaction.create({
          data: {
            businessId: actor.tenantId,
            supplierId: purchase.supplierId,
            type: 'PURCHASE',
            amount: totalReceivedValue,
            referenceType: 'PurchaseReceipt',
            referenceId: receipt.id,
            description: `Goods received against purchase ${purchase.purchaseNumber}`,
            createdBy: actor.id,
          },
        });
      }

      const refreshedItems = await tx.purchaseItem.findMany({ where: { purchaseId } });
      const fullyReceived = refreshedItems.every((i) => i.quantityReceived.greaterThanOrEqualTo(i.quantityOrdered));
      await tx.purchase.update({
        where: { id: purchaseId },
        data: { status: fullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED' },
      });

      const finalReceipt = await tx.purchaseReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: { items: true } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'PurchaseReceipt',
        entityId: receipt.id,
        after: finalReceipt,
        reason: `Received against purchase ${purchase.purchaseNumber}`,
      });

      return finalReceipt;
    });
  }
}
