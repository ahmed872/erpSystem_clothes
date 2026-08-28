import { Injectable } from '@nestjs/common';
import type { SupplierListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { getSupplierBalance } from '../../domain/supplier-balance';

@Injectable()
export class ListSuppliersUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, query: SupplierListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const where = {
        businessId: actor.tenantId,
        isActive: query.isActive,
        name: query.search ? { contains: query.search, mode: 'insensitive' as const } : undefined,
      };

      const [total, suppliers] = await Promise.all([
        tx.supplier.count({ where }),
        tx.supplier.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      const data = await Promise.all(
        suppliers.map(async (s) => ({ ...s, balance: (await getSupplierBalance(tx, actor.tenantId, s.id)).toString() })),
      );

      return {
        data,
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
      };
    });
  }
}
