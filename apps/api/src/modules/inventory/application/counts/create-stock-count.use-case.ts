import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreateStockCountInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class CreateStockCountUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: CreateStockCountInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId, businessId: actor.tenantId } });
      if (!warehouse) throw new NotFoundDomainError('Warehouse', input.warehouseId);

      let variantIds = input.variantIds;
      if (!variantIds || variantIds.length === 0) {
        const balances = await tx.stockBalance.findMany({
          where: { businessId: actor.tenantId, warehouseId: input.warehouseId },
          select: { variantId: true },
        });
        variantIds = balances.map((b) => b.variantId);
        if (variantIds.length === 0) {
          throw new ValidationFailedError('This warehouse has no stock balances to count yet');
        }
      } else {
        if (new Set(variantIds).size !== variantIds.length) {
          throw new ValidationFailedError('Duplicate variantId in stock count request');
        }
        const variants = await tx.productVariant.findMany({ where: { id: { in: variantIds }, businessId: actor.tenantId } });
        if (variants.length !== variantIds.length) {
          throw new ValidationFailedError('One or more variantIds do not belong to this business');
        }
      }

      const balances = await tx.stockBalance.findMany({
        where: { businessId: actor.tenantId, warehouseId: input.warehouseId, variantId: { in: variantIds } },
      });
      const balanceByVariant = new Map(balances.map((b) => [b.variantId, b.quantityOnHand]));

      const stockCount = await tx.stockCount.create({
        data: {
          businessId: actor.tenantId,
          warehouseId: input.warehouseId,
          createdBy: actor.id,
          items: {
            createMany: {
              data: variantIds.map((variantId) => ({
                variantId,
                expectedQuantity: balanceByVariant.get(variantId) ?? new Prisma.Decimal(0),
              })),
            },
          },
        },
        include: { items: true },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'StockCount',
        entityId: stockCount.id,
        after: { warehouseId: input.warehouseId, itemCount: variantIds.length },
      });

      return stockCount;
    });
  }
}
