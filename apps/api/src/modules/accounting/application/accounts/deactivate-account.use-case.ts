import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * A system account (isSystemAccount=true, referenced by an
 * AccountingMappingRule) can never be deactivated - doing so would make
 * every future automatic posting that resolves to it fail with "cannot
 * post to an inactive account" (AccountingEngineService), which is
 * correct for a tenant-created account no longer in use, but would
 * silently break Sales/Purchasing for a system one. No account is ever
 * hard-deleted - deactivation only, same posture as every other
 * "protected default" entity in this codebase (Customer.isActive,
 * ProductVariant.status).
 */
@Injectable()
export class DeactivateAccountUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, accountId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const account = await tx.account.findFirst({ where: { id: accountId, businessId: actor.tenantId } });
      if (!account) throw new NotFoundDomainError('Account', accountId);
      if (account.isSystemAccount) {
        throw new ValidationFailedError('A system account cannot be deactivated - it is required for automatic accounting postings', { accountId });
      }
      if (!account.isActive) {
        throw new ConflictDomainError('This account is already deactivated');
      }

      const updated = await tx.account.update({ where: { id: accountId }, data: { isActive: false, updatedBy: actor.id } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Account',
        entityId: account.id,
        before: { isActive: true },
        after: { isActive: false },
        reason: 'Account deactivated',
      });

      return updated;
    });
  }
}
