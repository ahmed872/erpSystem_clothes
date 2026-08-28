import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { resolveAllowNegative } from '../../domain/resolve-allow-negative';

/**
 * SUBMITTED -> APPROVED. For every counted item, applies an ADJUSTMENT
 * bringing the balance to exactly the counted quantity - via
 * InventoryEngine.applyAbsoluteQuantity, which computes the delta from
 * the LIVE, locked balance at approval time, not the `expectedQuantity`
 * snapshot taken when the count was created. This matters: if sales
 * happened between counting and approval, using the stale snapshot would
 * either double-correct or silently undo those sales. Items never
 * counted (actualQuantity still null) are skipped, not zeroed out.
 */
@Injectable()
export class ApproveStockCountUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngineService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, stockCountId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const stockCount = await tx.stockCount.findFirst({
        where: { id: stockCountId, businessId: actor.tenantId },
        include: { items: true, warehouse: true },
      });
      if (!stockCount) throw new NotFoundDomainError('StockCount', stockCountId);
      if (stockCount.status !== 'SUBMITTED') {
        throw new ConflictDomainError(`Only a SUBMITTED count can be approved (current status: ${stockCount.status})`);
      }

      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const allowNegative = await resolveAllowNegative(tx, actor.tenantId, permissions ?? new Set());

      const adjustments: { variantId: string; delta: string; movementId: string | null }[] = [];

      for (const item of stockCount.items) {
        if (item.actualQuantity === null) continue;

        const result = await this.engine.applyAbsoluteQuantity(tx, {
          businessId: actor.tenantId,
          branchId: stockCount.warehouse.branchId,
          warehouseId: stockCount.warehouseId,
          variantId: item.variantId,
          targetQuantity: item.actualQuantity,
          movementType: 'ADJUSTMENT',
          referenceType: 'StockCount',
          referenceId: stockCountId,
          reason: `Stock count approval${item.reason ? `: ${item.reason}` : ''}`,
          createdBy: actor.id,
          allowNegative,
        });

        if (result.movement) {
          adjustments.push({ variantId: item.variantId, delta: result.movement.quantityBase.toString(), movementId: result.movement.id });
        }
      }

      const updated = await tx.stockCount.update({
        where: { id: stockCountId },
        data: { status: 'APPROVED', approvedBy: actor.id, approvedAt: new Date() },
        include: { items: true },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'StockCount',
        entityId: stockCountId,
        before: { status: 'SUBMITTED' },
        after: { status: 'APPROVED', adjustments },
        reason: 'Stock count approved',
      });

      return { ...updated, adjustments };
    });
  }
}
