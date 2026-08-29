import { Injectable } from '@nestjs/common';
import type { AccountListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class ListAccountsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, query: AccountListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const where = { businessId: actor.tenantId, isActive: query.isActive };
      const [total, accounts] = await Promise.all([
        tx.account.count({ where }),
        tx.account.findMany({
          where,
          orderBy: { code: 'asc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);
      return { data: accounts, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
    });
  }
}
