import { Injectable } from '@nestjs/common';
import type { UpdateCustomerInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class UpdateCustomerUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, customerId: string, input: UpdateCustomerInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.customer.findFirst({ where: { id: customerId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('Customer', customerId);

      const customer = await tx.customer.update({
        where: { id: customerId },
        data: {
          name: input.name,
          phone: input.phone,
          email: input.email,
          address: input.address,
          taxNumber: input.taxNumber,
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Customer',
        entityId: customer.id,
        before,
        after: customer,
      });

      return customer;
    });
  }
}
