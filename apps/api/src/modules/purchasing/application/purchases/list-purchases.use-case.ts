import { Injectable } from '@nestjs/common';
import type { PurchaseListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class ListPurchasesUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, query: PurchaseListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const where = {
        businessId: actor.tenantId,
        supplierId: query.supplierId,
        warehouseId: query.warehouseId,
        branchId: query.branchId,
        status: query.status,
      };

      const [total, purchases] = await Promise.all([
        tx.purchase.count({ where }),
        tx.purchase.findMany({
          where,
          include: { supplier: { select: { id: true, name: true } }, warehouse: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      return {
        data: purchases,
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
      };
    });
  }
}
