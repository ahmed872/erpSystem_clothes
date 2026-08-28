import { Injectable } from '@nestjs/common';
import type { RecordOpeningStockInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { ConflictDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { loadVariantContext } from '../../domain/load-variant-context';
import { toBaseQuantity, toBaseUnitCost } from '../../domain/uom-conversion';
import { resolveOrCreateLot, createSerialsForReceipt } from '../../domain/lot-and-serial';
import { resolveAllowNegative } from '../../domain/resolve-allow-negative';

/**
 * Records the ONE-TIME starting balance for a (warehouse, variant) pair.
 * Allowed exactly once - if any StockMovement already exists for this
 * pair, the caller must use an Adjustment instead (opening balance is a
 * seed, not a correction tool).
 */
@Injectable()
export class RecordOpeningStockUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngineService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, input: RecordOpeningStockInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const { warehouse, product } = await loadVariantContext(tx, actor.tenantId, input.warehouseId, input.variantId);

      const alreadySeeded = await tx.stockMovement.findFirst({
        where: { businessId: actor.tenantId, warehouseId: input.warehouseId, variantId: input.variantId },
        select: { id: true },
      });
      if (alreadySeeded) {
        throw new ConflictDomainError('Opening stock was already recorded for this variant/warehouse; use an adjustment instead');
      }

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
        movementType: 'OPENING_BALANCE',
        unitCostOverride: baseCost,
        uomId: input.uomId,
        quantityInUom: input.uomId ? input.quantity : undefined,
        lotId,
        reason: input.reason ?? 'Opening stock',
        createdBy: actor.id,
        allowNegative,
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'StockMovement',
        entityId: result.movement.id,
        after: { movementType: 'OPENING_BALANCE', quantityBase: baseQty.toString(), unitCost: baseCost.toString() },
      });

      return {
        movementId: result.movement.id,
        quantityOnHand: result.quantityOnHand.toString(),
        averageCost: result.averageCost.toString(),
      };
    });
  }
}
