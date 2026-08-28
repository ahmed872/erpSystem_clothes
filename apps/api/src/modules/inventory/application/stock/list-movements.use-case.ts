import { Injectable } from '@nestjs/common';
import type { InventoryListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { omitFields } from '../../../catalog/domain/omit-fields';

@Injectable()
export class ListMovementsUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, query: InventoryListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const canViewCost = permissions?.has('products.view_cost') ?? false;

      const where = {
        businessId: actor.tenantId,
        warehouseId: query.warehouseId,
        variantId: query.variantId,
        movementType: query.movementType,
      };

      const [total, movements] = await Promise.all([
        tx.stockMovement.count({ where }),
        tx.stockMovement.findMany({
          where,
          include: {
            variant: { select: { id: true, sku: true } },
            warehouse: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      return {
        data: canViewCost ? movements : movements.map((m) => omitFields(m, ['unitCostAtMovement'])),
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
      };
    });
  }
}
