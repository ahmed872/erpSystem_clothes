import { Injectable } from '@nestjs/common';
import type { ConsumeStockInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { canViewInventoryCost, stripStockCost } from '../../domain/stock-result-visibility';
import { resolveAllowNegative } from '../../domain/resolve-allow-negative';
import { consumeVariant } from '../../domain/consume-variant';

/**
 * Generic stock-out primitive (SALE / PURCHASE_RETURN), and the endpoint
 * used for a standalone, one-line consumption. The actual consumption
 * logic (including Bundle expansion) now lives in the tx-accepting
 * `consumeVariant` domain helper (see its doc comment) - this use case
 * is a thin wrapper that opens its own transaction and reshapes the
 * result back into this endpoint's original response shape, so its
 * external behavior is byte-for-byte unchanged from Phase 3. Phase 5's
 * Sale completion calls `consumeVariant` directly instead of this class,
 * so a multi-line Sale stays one atomic transaction.
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
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const allowNegative = await resolveAllowNegative(tx, actor.tenantId, permissions ?? new Set());

      const result = await consumeVariant(tx, this.engine, this.audit, {
        businessId: actor.tenantId,
        warehouseId: input.warehouseId,
        variantId: input.variantId,
        quantity: input.quantity,
        uomId: input.uomId,
        movementType: input.movementType,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        lotId: input.lotId,
        reason: input.reason,
        serials: input.serials,
        createdBy: actor.id,
        allowNegative,
      });

      if (result.bundleProductId) {
        return { bundleProductId: result.bundleProductId, componentsConsumed: result.componentsConsumed };
      }
      return stripStockCost(
        {
          movementId: result.movementId,
          quantityOnHand: result.quantityOnHand,
          averageCost: result.averageCost,
          cogsPerUnit: result.cogsPerUnit,
        },
        await canViewInventoryCost(this.effectivePermissions, tx, actor.id),
      );
    });
  }
}
