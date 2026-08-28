import { Injectable } from '@nestjs/common';
import type { ReceiveStockTransferInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { resolveAllowNegative } from '../../domain/resolve-allow-negative';

/**
 * IN_TRANSIT -> COMPLETED. Increments the DESTINATION warehouse using
 * the COST CARRIED OVER from each item's own TRANSFER_OUT movement (a
 * transfer between warehouses of the same business is not a purchase -
 * it must never fabricate a new cost basis). All items must be received
 * together in one call (no partial/staged receiving in Phase 3 - see
 * Known Issues); `quantityReceived` may differ from the sent `quantity`
 * to capture shrinkage/damage in transit, and that difference is
 * reported, not silently corrected.
 */
@Injectable()
export class ReceiveStockTransferUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngineService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, transferId: string, input: ReceiveStockTransferInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const transfer = await tx.stockTransfer.findFirst({
        where: { id: transferId, businessId: actor.tenantId },
        include: { items: true, destinationWarehouse: true },
      });
      if (!transfer) throw new NotFoundDomainError('StockTransfer', transferId);
      if (transfer.status !== 'IN_TRANSIT') {
        throw new ConflictDomainError(`Only an IN_TRANSIT transfer can be received (current status: ${transfer.status})`);
      }

      const transferVariantIds = new Set(transfer.items.map((i) => i.variantId));
      const inputVariantIds = input.items.map((i) => i.variantId);
      if (new Set(inputVariantIds).size !== inputVariantIds.length) {
        throw new ValidationFailedError('Duplicate variantId in receive request');
      }
      if (input.items.length !== transfer.items.length || inputVariantIds.some((id) => !transferVariantIds.has(id))) {
        throw new ValidationFailedError('All items of this transfer must be received together, matching exactly what was sent');
      }

      const sentMovements = await tx.stockMovement.findMany({
        where: { businessId: actor.tenantId, referenceType: 'StockTransfer', referenceId: transferId, movementType: 'TRANSFER_OUT' },
      });
      const costByVariant = new Map(sentMovements.map((m) => [m.variantId, m.unitCostAtMovement]));

      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const allowNegative = await resolveAllowNegative(tx, actor.tenantId, permissions ?? new Set());

      for (const item of input.items) {
        const cost = costByVariant.get(item.variantId);
        if (cost === undefined) {
          throw new ValidationFailedError(`No sent movement found for variant ${item.variantId} - transfer data is inconsistent`);
        }

        if (item.quantityReceived > 0) {
          await this.engine.applyMovement(tx, {
            businessId: actor.tenantId,
            branchId: transfer.destinationWarehouse.branchId,
            warehouseId: transfer.destinationWarehouseId,
            variantId: item.variantId,
            quantityDelta: item.quantityReceived,
            movementType: 'TRANSFER_IN',
            unitCostOverride: cost,
            referenceType: 'StockTransfer',
            referenceId: transferId,
            reason: 'Stock transfer received',
            createdBy: actor.id,
            allowNegative,
          });
        }

        await tx.stockTransferItem.update({
          where: { stockTransferId_variantId: { stockTransferId: transferId, variantId: item.variantId } },
          data: { quantityReceived: item.quantityReceived },
        });
      }

      const updated = await tx.stockTransfer.update({
        where: { id: transferId },
        data: { status: 'COMPLETED', receivedBy: actor.id, receivedAt: new Date() },
        include: { items: true },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'StockTransfer',
        entityId: transferId,
        before: { status: 'IN_TRANSIT' },
        after: { status: 'COMPLETED', items: input.items },
        reason: 'Transfer received',
      });

      return updated;
    });
  }
}
