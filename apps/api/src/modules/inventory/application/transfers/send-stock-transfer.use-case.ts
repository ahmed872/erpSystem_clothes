import { Injectable } from '@nestjs/common';
import type { SendStockTransferInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { resolveAllowNegative } from '../../domain/resolve-allow-negative';
import { assertNoSerialsForUntrackedVariant } from '../../domain/lot-and-serial';
import { shipSerialsOnTransfer } from '../../domain/serial-movements';
import { ValidationFailedError } from '../../../../common/errors/domain-error';

/**
 * DRAFT -> IN_TRANSIT. Decrements the SOURCE warehouse for every item in
 * one atomic transaction (TRANSFER_OUT movements) - the destination is
 * untouched until ReceiveStockTransferUseCase runs (Phase 0 §29: source
 * decreases on send, destination only increases on receive).
 */
@Injectable()
export class SendStockTransferUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngineService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, transferId: string, input: SendStockTransferInput = {}) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const transfer = await tx.stockTransfer.findFirst({
        where: { id: transferId, businessId: actor.tenantId },
        // Phase 10 (10D): the product's tracking flag decides whether a
        // line must name its physical units - never the request.
        include: {
          items: { include: { variant: { include: { product: { select: { tracksSerialNumbers: true } } } } } },
          sourceWarehouse: true,
        },
      });
      if (!transfer) throw new NotFoundDomainError('StockTransfer', transferId);
      if (transfer.status !== 'DRAFT') {
        throw new ConflictDomainError(`Only a DRAFT transfer can be sent (current status: ${transfer.status})`);
      }

      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const allowNegative = await resolveAllowNegative(tx, actor.tenantId, permissions ?? new Set());

      const serialsByVariant = new Map((input.items ?? []).map((i) => [i.variantId, i.serials]));
      const transferVariantIds = new Set(transfer.items.map((i) => i.variantId));
      for (const variantId of serialsByVariant.keys()) {
        if (!transferVariantIds.has(variantId)) {
          throw new ValidationFailedError('Serials were supplied for a variant that is not on this transfer', { variantId });
        }
      }

      for (const item of transfer.items) {
        await this.engine.applyMovement(tx, {
          businessId: actor.tenantId,
          branchId: transfer.sourceWarehouse.branchId,
          warehouseId: transfer.sourceWarehouseId,
          variantId: item.variantId,
          quantityDelta: item.quantity.negated(),
          movementType: 'TRANSFER_OUT',
          referenceType: 'StockTransfer',
          referenceId: transferId,
          reason: 'Stock transfer sent',
          createdBy: actor.id,
          allowNegative,
        });

        // Phase 10 (10D): the units physically going in the box move to
        // IN_TRANSIT and stop belonging to either warehouse. Before this,
        // a transferred serial kept pointing at the warehouse it had left,
        // so it could be sold at neither end - a silent failure, because
        // the transfer itself succeeded and only the later sale broke.
        if (item.variant.product.tracksSerialNumbers) {
          const serialIds = await shipSerialsOnTransfer(
            tx,
            actor.tenantId,
            item.variantId,
            transfer.sourceWarehouseId,
            serialsByVariant.get(item.variantId),
            item.quantity,
          );
          for (const serialNumberId of serialIds) {
            await tx.stockTransferItemSerial.create({
              data: {
                businessId: actor.tenantId,
                stockTransferId: transferId,
                stockTransferItemId: item.id,
                serialNumberId,
              },
            });
          }
        } else {
          assertNoSerialsForUntrackedVariant(serialsByVariant.get(item.variantId), item.variantId);
        }
      }

      const updated = await tx.stockTransfer.update({
        where: { id: transferId },
        data: { status: 'IN_TRANSIT', sentBy: actor.id, sentAt: new Date() },
        include: { items: true },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'StockTransfer',
        entityId: transferId,
        before: { status: 'DRAFT' },
        after: { status: 'IN_TRANSIT' },
        reason: 'Transfer sent',
      });

      return updated;
    });
  }
}
