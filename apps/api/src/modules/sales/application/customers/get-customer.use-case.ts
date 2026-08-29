import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { getCustomerBalance } from '../../domain/customer-balance';

@Injectable()
export class GetCustomerUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, customerId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: customerId, businessId: actor.tenantId } });
      if (!customer) throw new NotFoundDomainError('Customer', customerId);

      const [balance, transactions] = await Promise.all([
        getCustomerBalance(tx, actor.tenantId, customerId),
        tx.customerTransaction.findMany({
          where: { businessId: actor.tenantId, customerId },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
      ]);

      return { ...customer, balance: balance.toString(), recentTransactions: transactions };
    });
  }
}
