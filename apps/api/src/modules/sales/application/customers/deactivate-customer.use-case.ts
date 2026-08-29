import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/** Soft-delete only - erp_app has no DELETE grant on customers at all
 * (a Customer is referenced by every Sale/CustomerTransaction ever
 * created against it). Mirrors DeactivateSupplierUseCase (Phase 4). */
@Injectable()
export class DeactivateCustomerUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, customerId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.customer.findFirst({ where: { id: customerId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('Customer', customerId);
      if (!before.isActive) throw new ConflictDomainError('Customer is already inactive');

      const customer = await tx.customer.update({ where: { id: customerId }, data: { isActive: false, updatedBy: actor.id } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Customer',
        entityId: customer.id,
        before: { isActive: true },
        after: { isActive: false },
        reason: 'Customer deactivated',
      });

      return customer;
    });
  }
}
