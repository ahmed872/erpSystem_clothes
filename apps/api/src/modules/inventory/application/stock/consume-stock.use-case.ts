import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ConsumeStockInput } from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { loadVariantContext } from '../../domain/load-variant-context';
import { toBaseQuantity } from '../../domain/uom-conversion';
import { consumeSerialsForSale } from '../../domain/lot-and-serial';
import { resolveAllowNegative } from '../../domain/resolve-allow-negative';

/**
 * Generic stock-out primitive (SALE / PURCHASE_RETURN) - the method
 * Phase 5's Sales module is expected to call once it exists. This is
 * also where Bundle consumption happens: selling a Bundle-type variant
 * consumes its BundleItem components, never the bundle "itself" (Phase
 * 0/2: a bundle carries no inventory of its own). Both this variant's
 * consumption and each bundle component's consumption go through
 * InventoryEngine.applyMovement, which is what makes the whole thing one
 * atomic transaction - if any single component is short, the entire
 * consumption (all components) rolls back, never a partial bundle sale.
 */
@Injectable()
export class ConsumeStockUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngineService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, input: ConsumeStockInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const { warehouse, product } = await loadVariantContext(tx, actor.tenantId, input.warehouseId, input.variantId);
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const allowNegative = await resolveAllowNegative(tx, actor.tenantId, permissions ?? new Set());

      if (product.type === 'BUNDLE') {
        return this.consumeBundle(tx, actor, warehouse.branchId, product.id, input, allowNegative);
      }

      const baseQty = toBaseQuantity(product.baseUomId, product.productUoms, input.uomId, input.quantity);

      if (product.tracksSerialNumbers && input.movementType === 'SALE') {
        await consumeSerialsForSale(tx, actor.tenantId, input.variantId, input.warehouseId, input.serials, input.quantity);
      }

      const result = await this.engine.applyMovement(tx, {
        businessId: actor.tenantId,
        branchId: warehouse.branchId,
        warehouseId: input.warehouseId,
        variantId: input.variantId,
        quantityDelta: baseQty.negated(),
        movementType: input.movementType,
        uomId: input.uomId,
        quantityInUom: input.uomId ? input.quantity : undefined,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        lotId: input.lotId,
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
        after: {
          movementType: input.movementType,
          quantityBase: baseQty.negated().toString(),
          cogsPerUnit: result.movement.unitCostAtMovement.toString(),
        },
      });

      return {
        movementId: result.movement.id,
        quantityOnHand: result.quantityOnHand.toString(),
        averageCost: result.averageCost.toString(),
        cogsPerUnit: result.movement.unitCostAtMovement.toString(),
      };
    });
  }

  private async consumeBundle(
    tx: TenantTx,
    actor: RequestUser,
    branchId: string,
    bundleProductId: string,
    input: ConsumeStockInput,
    allowNegative: boolean,
  ) {
    const bundleItems = await tx.bundleItem.findMany({ where: { bundleProductId } });
    if (bundleItems.length === 0) {
      throw new ValidationFailedError('This bundle has no components configured');
    }

    const bundleQty = new Prisma.Decimal(input.quantity);
    const components: { variantId: string; movementId: string; quantityConsumed: string; unitCost: string }[] = [];

    for (const item of bundleItems) {
      // BundleItem.quantity is expressed directly in the component
      // variant's own base UOM (Phase 2 bundle items carry no UOM of
      // their own) - no conversion needed here.
      const componentQtyBase = item.quantity.times(bundleQty);

      const result = await this.engine.applyMovement(tx, {
        businessId: actor.tenantId,
        branchId,
        warehouseId: input.warehouseId,
        variantId: item.componentVariantId,
        quantityDelta: componentQtyBase.negated(),
        movementType: 'BUNDLE_CONSUMPTION',
        referenceType: input.referenceType ?? 'BundleSale',
        referenceId: input.referenceId ?? bundleProductId,
        reason: input.reason ?? `Bundle consumption for product ${bundleProductId}`,
        createdBy: actor.id,
        allowNegative,
      });

      components.push({
        variantId: item.componentVariantId,
        movementId: result.movement.id,
        quantityConsumed: componentQtyBase.toString(),
        unitCost: result.movement.unitCostAtMovement.toString(),
      });
    }

    await this.audit.record(tx, {
      businessId: actor.tenantId,
      userId: actor.id,
      action: 'CREATE',
      entityType: 'BundleConsumption',
      entityId: bundleProductId,
      after: { bundleQuantity: bundleQty.toString(), components },
    });

    return { bundleProductId, componentsConsumed: components };
  }
}
