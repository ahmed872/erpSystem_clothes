import { Injectable } from '@nestjs/common';
import type { SaleListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class ListSalesUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, query: SaleListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const where = {
        businessId: actor.tenantId,
        customerId: query.customerId,
        warehouseId: query.warehouseId,
        branchId: query.branchId,
        shiftId: query.shiftId,
      };

      const [total, sales] = await Promise.all([
        tx.sale.count({ where }),
        tx.sale.findMany({
          where,
          include: { customer: { select: { id: true, name: true } }, warehouse: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      return {
        data: sales,
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
      };
    });
  }
}
