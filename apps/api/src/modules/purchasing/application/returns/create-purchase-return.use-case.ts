import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type { CreatePurchaseReturnInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { resolveAllowNegative } from '../../../inventory/domain/resolve-allow-negative';
import { lockPurchase } from '../../domain/lock-purchase';
import { documentNumberFromId } from '../../../../common/domain/document-number';
import { AccountingEngineService } from '../../../../engines/accounting/accounting-engine.service';
import { buildPurchaseReturnJournalLines } from '../../../accounting/domain/purchase-journal-lines';
import { assertNoSerialsForUntrackedVariant } from '../../../inventory/domain/lot-and-serial';
import { returnSerialsToSupplier } from '../../../inventory/domain/serial-movements';
import { DOCUMENT_LINE_ORDER } from '../../domain/document-line-order';

/**
 * A purchase return is a single-step atomic action (not a draft/confirm
 * workflow, unlike Purchase itself): it immediately reverses the
 * inventory impact of a prior receipt via InventoryEngineService
 * (movementType PURCHASE_RETURN, a real decrease movement - never a
 * modification or deletion of the original PURCHASE movement) and posts
 * the supplier credit, all in one transaction.
 *
 * Deliberately NOT gated on Purchase.status: a return is valid as long
 * as the specific PurchaseItem line still has quantity available to
 * return (quantityReceived - quantityReturned), independent of whatever
 * terminal state the document itself is in (e.g. a purchase cancelled
 * after a partial receipt can still have that received portion
 * returned).
 */
@Injectable()
export class CreatePurchaseReturnUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngineService,
    private readonly effectivePermissions: EffectivePermissionsService,
    private readonly accounting: AccountingEngineService,
  ) {}

  async execute(actor: RequestUser, purchaseId: string, input: CreatePurchaseReturnInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      await lockPurchase(tx, actor.tenantId, purchaseId);
      const purchase = await tx.purchase.findFirst({
        where: { id: purchaseId, businessId: actor.tenantId },
        // Phase 10 (10D): only the server may decide whether a line needs
        // serials, so the product's tracking flag comes with the item.
        include: { items: { include: { variant: { include: { product: { select: { tracksSerialNumbers: true } } } } }, orderBy: DOCUMENT_LINE_ORDER } },
      });
      if (!purchase) throw new NotFoundDomainError('Purchase', purchaseId);

      const itemIds = input.items.map((i) => i.purchaseItemId);
      if (new Set(itemIds).size !== itemIds.length) {
        throw new ValidationFailedError('Duplicate purchaseItemId in return request');
      }
      const itemsById = new Map(purchase.items.map((i) => [i.id, i]));
      for (const line of input.items) {
        const purchaseItem = itemsById.get(line.purchaseItemId);
        if (!purchaseItem) throw new NotFoundDomainError('PurchaseItem', line.purchaseItemId);

        const available = purchaseItem.quantityReceived.minus(purchaseItem.quantityReturned);
        if (new Prisma.Decimal(line.quantity).greaterThan(available)) {
          throw new ConflictDomainError(
            `Cannot return ${line.quantity} of variant ${purchaseItem.variantId} - only ${available.toString()} is available to return (received minus already returned)`,
            { purchaseItemId: purchaseItem.id, available: available.toString(), requested: line.quantity },
          );
        }
      }

      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const allowNegative = await resolveAllowNegative(tx, actor.tenantId, permissions ?? new Set());

      const returnId = randomUUID();
      const purchaseReturn = await tx.purchaseReturn.create({
        data: {
          id: returnId,
          businessId: actor.tenantId,
          purchaseId,
          warehouseId: purchase.warehouseId,
          // purchase_returns is append-only at the DB privilege level
          // (SELECT+INSERT only, no UPDATE) - same reasoning as
          // PurchaseReceipt above.
          returnNumber: documentNumberFromId('PRET', returnId),
          reason: input.reason,
          createdBy: actor.id,
        },
      });

      let totalCredit = new Prisma.Decimal(0);
      for (const line of input.items) {
        const purchaseItem = itemsById.get(line.purchaseItemId)!;

        // unitCostOverride is deliberately NOT passed - a decrease always
        // costs out at the ledger's CURRENT weighted-average cost (Phase
        // 3 costing rule, zero special-casing for returns). The supplier
        // credit below uses the ORIGINAL purchase cost instead, which is
        // a separate concern (what we're owed back) from stock valuation
        // (what the stock is worth today).
        await this.engine.applyMovement(tx, {
          businessId: actor.tenantId,
          branchId: purchase.branchId,
          warehouseId: purchase.warehouseId,
          variantId: purchaseItem.variantId,
          quantityDelta: new Prisma.Decimal(line.quantity).negated(),
          movementType: 'PURCHASE_RETURN',
          referenceType: 'PurchaseReturn',
          referenceId: purchaseReturn.id,
          reason: input.reason ?? `Purchase return against ${purchase.purchaseNumber}`,
          createdBy: actor.id,
          allowNegative,
        });

        const returnItem = await tx.purchaseReturnItem.create({
          data: {
            businessId: actor.tenantId,
            purchaseReturnId: purchaseReturn.id,
            purchaseItemId: purchaseItem.id,
            variantId: purchaseItem.variantId,
            quantity: line.quantity,
            unitCost: purchaseItem.unitCost,
          },
        });

        // Phase 10 (10D): the exact physical units going back to the
        // supplier. RETURNED_TO_SUPPLIER is terminal - the row survives so
        // the serial can never be re-registered later as fresh stock.
        if (purchaseItem.variant.product.tracksSerialNumbers) {
          const serialIds = await returnSerialsToSupplier(
            tx,
            actor.tenantId,
            purchaseItem.variantId,
            purchase.warehouseId,
            line.serials,
            line.quantity,
          );
          for (const serialNumberId of serialIds) {
            await tx.purchaseReturnItemSerial.create({
              data: {
                businessId: actor.tenantId,
                purchaseReturnId: purchaseReturn.id,
                purchaseReturnItemId: returnItem.id,
                serialNumberId,
              },
            });
          }
        } else {
          assertNoSerialsForUntrackedVariant(line.serials, purchaseItem.variantId);
        }

        await tx.purchaseItem.update({
          where: { id: purchaseItem.id },
          data: { quantityReturned: purchaseItem.quantityReturned.plus(line.quantity) },
        });

        totalCredit = totalCredit.plus(new Prisma.Decimal(line.quantity).times(purchaseItem.unitCost));
      }

      if (totalCredit.greaterThan(0)) {
        await tx.supplierTransaction.create({
          data: {
            businessId: actor.tenantId,
            supplierId: purchase.supplierId,
            type: 'PURCHASE_RETURN',
            amount: totalCredit.negated(),
            referenceType: 'PurchaseReturn',
            referenceId: purchaseReturn.id,
            description: `Purchase return credit against ${purchase.purchaseNumber}`,
            createdBy: actor.id,
          },
        });
      }

      // Phase 6: post the accounting fact for this return in the SAME
      // transaction - totalCredit is the exact same figure the
      // SupplierTransaction above just used.
      const returnJournalLines = await buildPurchaseReturnJournalLines(tx, actor.tenantId, totalCredit);
      if (returnJournalLines.length > 0) {
        await this.accounting.postEntry(tx, {
          businessId: actor.tenantId,
          entryDate: new Date(),
          sourceType: 'PurchaseReturn',
          sourceId: purchaseReturn.id,
          description: `Purchase return against ${purchase.purchaseNumber}`,
          createdBy: actor.id,
          lines: returnJournalLines,
        });
      }

      const finalReturn = await tx.purchaseReturn.findUniqueOrThrow({
        where: { id: purchaseReturn.id },
        include: { items: { orderBy: DOCUMENT_LINE_ORDER } },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'PurchaseReturn',
        entityId: purchaseReturn.id,
        after: finalReturn,
        reason: input.reason ?? 'Purchase return',
      });

      return finalReturn;
    });
  }
}
