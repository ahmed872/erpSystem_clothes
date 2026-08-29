import { Injectable } from '@nestjs/common';
import type { CustomerListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { getCustomerBalance } from '../../domain/customer-balance';

@Injectable()
export class ListCustomersUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, query: CustomerListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const where = {
        businessId: actor.tenantId,
        isActive: query.isActive,
        name: query.search ? { contains: query.search, mode: 'insensitive' as const } : undefined,
      };

      const [total, customers] = await Promise.all([
        tx.customer.count({ where }),
        tx.customer.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      const data = await Promise.all(
        customers.map(async (c) => ({ ...c, balance: (await getCustomerBalance(tx, actor.tenantId, c.id)).toString() })),
      );

      return {
        data,
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
      };
    });
  }
}
