import { Injectable } from '@nestjs/common';
import type { CreateCustomerInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class CreateCustomerUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: CreateCustomerInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const customer = await tx.customer.create({
        data: {
          businessId: actor.tenantId,
          name: input.name,
          phone: input.phone,
          email: input.email,
          address: input.address,
          taxNumber: input.taxNumber,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Customer',
        entityId: customer.id,
        after: customer,
      });

      return customer;
    });
  }
}
