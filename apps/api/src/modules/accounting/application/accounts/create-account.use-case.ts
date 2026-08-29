import { Injectable } from '@nestjs/common';
import type { CreateAccountInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Tenant-specific accounts only - the default Chart of Accounts (system
 * accounts, isSystemAccount=true) is seeded once at onboarding
 * (seedAccountingDefaults) and never created through this endpoint. A
 * tenant-created account can be a child of ANY existing account
 * (system or tenant-created), but is itself never a system account.
 */
@Injectable()
export class CreateAccountUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: CreateAccountInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      if (input.parentAccountId) {
        const parent = await tx.account.findFirst({ where: { id: input.parentAccountId, businessId: actor.tenantId } });
        if (!parent) throw new NotFoundDomainError('Account', input.parentAccountId);
      }

      const account = await tx.account.create({
        data: {
          businessId: actor.tenantId,
          code: input.code,
          name: input.name,
          type: input.type,
          normalBalance: input.normalBalance,
          parentAccountId: input.parentAccountId,
          isSystemAccount: false,
          createdBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Account',
        entityId: account.id,
        after: account,
      });

      return account;
    });
  }
}
