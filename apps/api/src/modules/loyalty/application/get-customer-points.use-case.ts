import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';
import { getCustomerPointsBalance } from '../domain/customer-points-balance';

/**
 * Returns a customer's loyalty balance, always DERIVED as SUM(points) at
 * the moment of the read - never a stored figure. The customer is
 * resolved inside the caller's tenant first, so another business's
 * customer id resolves to a 404 rather than a zero balance.
 */
@Injectable()
export class GetCustomerPointsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, customerId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, businessId: actor.tenantId },
        select: { id: true, name: true, isActive: true },
      });
      if (!customer) throw new NotFoundDomainError('Customer', customerId);

      const balance = await getCustomerPointsBalance(tx, actor.tenantId, customerId);
      const events = await tx.customerPoints.count({ where: { businessId: actor.tenantId, customerId } });

      return {
        customerId: customer.id,
        customerName: customer.name,
        balance: balance.toString(),
        eventCount: events,
        // Stated on the response, not merely in the docs: this figure is
        // computed from the ledger on every read and is never cached.
        derivation: 'SUM(CustomerPoints.points) - no stored balance exists',
      };
    });
  }
}
