import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/** Rename only - a system account (isSystemAccount=true) can still be
 * renamed, since renaming never breaks a postEntry call that resolves
 * to it by id (AccountingMappingRule.accountId, not name). */
@Injectable()
export class UpdateAccountUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, accountId: string, input: { name: string }) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const account = await tx.account.findFirst({ where: { id: accountId, businessId: actor.tenantId } });
      if (!account) throw new NotFoundDomainError('Account', accountId);

      const updated = await tx.account.update({
        where: { id: accountId },
        data: { name: input.name, updatedBy: actor.id },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Account',
        entityId: account.id,
        before: { name: account.name },
        after: { name: updated.name },
      });

      return updated;
    });
  }
}
