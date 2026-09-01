import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AdjustStockInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { canViewInventoryCost, stripStockCost } from '../../domain/stock-result-visibility';
import { loadVariantContext } from '../../domain/load-variant-context';
import { toBaseQuantity } from '../../domain/uom-conversion';
import { resolveAllowNegative } from '../../domain/resolve-allow-negative';
import { AccountingEngineService } from '../../../../engines/accounting/accounting-engine.service';
import { buildInventoryAdjustmentJournalLines } from '../../../accounting/domain/inventory-adjustment-journal-lines';

/**
 * Signed manual correction: positive = found extra stock (ADJUSTMENT),
 * negative = shrinkage/damage/loss/expiry/internal consumption. Always
 * requires a reason (enforced by the zod schema). Cost basis for a
 * positive adjustment defaults to the current average cost (no new cost
 * information exists for "found" stock) via InventoryEngine's own
 * default when unitCostOverride is omitted.
 */
@Injectable()
export class AdjustStockUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngineService,
    private readonly effectivePermissions: EffectivePermissionsService,
    private readonly accounting: AccountingEngineService,
  ) {}

  async execute(actor: RequestUser, input: AdjustStockInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const { warehouse, product } = await loadVariantContext(tx, actor.tenantId, input.warehouseId, input.variantId);

      const magnitude = toBaseQuantity(product.baseUomId, product.productUoms, input.uomId, Math.abs(input.quantity));
      const baseQty = input.quantity > 0 ? magnitude : magnitude.negated();

      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const allowNegative = await resolveAllowNegative(tx, actor.tenantId, permissions ?? new Set());

      const result = await this.engine.applyMovement(tx, {
        businessId: actor.tenantId,
        branchId: warehouse.branchId,
        warehouseId: input.warehouseId,
        variantId: input.variantId,
        quantityDelta: baseQty,
        movementType: input.movementType,
        uomId: input.uomId,
        quantityInUom: input.uomId ? new Prisma.Decimal(Math.abs(input.quantity)) : undefined,
        reason: input.reason,
        createdBy: actor.id,
        allowNegative,
      });

      // Phase 6: post the accounting fact for this adjustment in the
      // SAME transaction - see buildInventoryAdjustmentJournalLines's
      // doc comment for the known no-idempotency-on-retry limitation
      // this inherits from Phase 3.
      const adjustmentJournalLines = await buildInventoryAdjustmentJournalLines(tx, actor.tenantId, {
        movementType: input.movementType,
        quantityDelta: baseQty,
        unitCostAtMovement: result.movement.unitCostAtMovement,
      });
      if (adjustmentJournalLines.length > 0) {
        await this.accounting.postEntry(tx, {
          businessId: actor.tenantId,
          entryDate: new Date(),
          sourceType: 'StockMovement',
          sourceId: result.movement.id,
          description: `Inventory adjustment: ${input.movementType} - ${input.reason}`,
          createdBy: actor.id,
          lines: adjustmentJournalLines,
        });
      }

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'StockMovement',
        entityId: result.movement.id,
        after: { movementType: input.movementType, quantityBase: baseQty.toString(), reason: input.reason },
        reason: input.reason,
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
