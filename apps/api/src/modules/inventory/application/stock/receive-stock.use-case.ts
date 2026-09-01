import { Injectable } from '@nestjs/common';
import type { ReceiveStockInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { canViewInventoryCost, stripStockCost } from '../../domain/stock-result-visibility';
import { loadVariantContext } from '../../domain/load-variant-context';
import { toBaseQuantity, toBaseUnitCost } from '../../domain/uom-conversion';
import { resolveOrCreateLot, createSerialsForReceipt } from '../../domain/lot-and-serial';
import { resolveAllowNegative } from '../../domain/resolve-allow-negative';

/**
 * Generic stock-in primitive (PURCHASE / SALES_RETURN). This is the
 * method Phase 4's Purchasing module and Phase 5's Sales-return flow are
 * expected to call once they exist - built now, as a real usable
 * endpoint, rather than deferred, per Phase 3 instructions.
 */
@Injectable()
export class ReceiveStockUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngineService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, input: ReceiveStockInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const { warehouse, product } = await loadVariantContext(tx, actor.tenantId, input.warehouseId, input.variantId);

      const baseQty = toBaseQuantity(product.baseUomId, product.productUoms, input.uomId, input.quantity);
      const baseCost = toBaseUnitCost(product.baseUomId, product.productUoms, input.uomId, input.unitCost);

      const lotId = product.tracksLots
        ? await resolveOrCreateLot(tx, actor.tenantId, input.variantId, input.lotNumber, input.expiryDate, input.manufacturingDate)
        : undefined;
      if (product.tracksSerialNumbers) {
        await createSerialsForReceipt(tx, actor.tenantId, input.variantId, input.warehouseId, input.serials, input.quantity);
      }

      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const allowNegative = await resolveAllowNegative(tx, actor.tenantId, permissions ?? new Set());

      const result = await this.engine.applyMovement(tx, {
        businessId: actor.tenantId,
        branchId: warehouse.branchId,
        warehouseId: input.warehouseId,
        variantId: input.variantId,
        quantityDelta: baseQty,
        movementType: input.movementType,
        unitCostOverride: baseCost,
        uomId: input.uomId,
        quantityInUom: input.uomId ? input.quantity : undefined,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        lotId,
        reason: input.reason,
        createdBy: actor.id,
        allowNegative,
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'StockMovement',
        entityId: result.movement.id,
        after: { movementType: input.movementType, quantityBase: baseQty.toString(), unitCost: baseCost.toString() },
      });

      return stripStockCost(
        {
          movementId: result.movement.id,
          quantityOnHand: result.quantityOnHand.toString(),
          averageCost: result.averageCost.toString(),
        },
        await canViewInventoryCost(this.effectivePermissions, tx, actor.id),
      );
    });
  }
}
