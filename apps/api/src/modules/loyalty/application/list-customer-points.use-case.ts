import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CustomerPointsListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';
import { getCustomerPointsBalance } from '../domain/customer-points-balance';

/**
 * The customer's own point history, newest first. Every row is a
 * permanent event: nothing here was ever edited, because `erp_app` holds
 * no UPDATE or DELETE privilege on the table.
 *
 * The running balance is returned alongside the page so a caller never
 * has to sum a paginated list themselves and accidentally derive a
 * balance from one page of it.
 */
@Injectable()
export class ListCustomerPointsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, customerId: string, query: CustomerPointsListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, businessId: actor.tenantId },
        select: { id: true },
      });
      if (!customer) throw new NotFoundDomainError('Customer', customerId);

      const where: Prisma.CustomerPointsWhereInput = {
        businessId: actor.tenantId,
        customerId,
        type: query.type,
      };

      const [total, data, balance] = await Promise.all([
        tx.customerPoints.count({ where }),
        tx.customerPoints.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        getCustomerPointsBalance(tx, actor.tenantId, customerId),
      ]);

      return {
        data,
        // Always the WHOLE customer's balance, never this page's subtotal,
        // and never affected by the `type` filter.
        balance: balance.toString(),
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
      };
    });
  }
}
