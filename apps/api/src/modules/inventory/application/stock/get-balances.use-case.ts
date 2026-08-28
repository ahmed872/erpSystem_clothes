import { Injectable } from '@nestjs/common';
import type { BalanceQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { omitFields } from '../../../catalog/domain/omit-fields';

@Injectable()
export class GetBalancesUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, query: BalanceQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const canViewCost = permissions?.has('products.view_cost') ?? false;

      const balances = await tx.stockBalance.findMany({
        where: { businessId: actor.tenantId, warehouseId: query.warehouseId, variantId: query.variantId },
        include: { variant: { select: { id: true, sku: true, product: { select: { id: true, name: true } } } }, warehouse: { select: { id: true, name: true } } },
        orderBy: { updatedAt: 'desc' },
      });

      return balances.map((b) => ({
        ...(canViewCost ? b : omitFields(b, ['averageCost'])),
        availableQuantity: b.quantityOnHand.minus(b.quantityReserved).toString(),
      }));
    });
  }
}
