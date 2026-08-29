import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { lockFiscalPeriodById } from '../../domain/lock-fiscal-period';

/**
 * Reopens a closed fiscal period - gated by `accounting.reopen_period`
 * (Phase 0 §6.4 names this exact permission), deliberately separate from
 * `accounting.periods.manage` (open/close) so it can be audited and
 * restricted independently, per the review's own §N.
 */
@Injectable()
export class ReopenPeriodUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, periodId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const locked = await lockFiscalPeriodById(tx, actor.tenantId, periodId);
      if (locked.status !== 'CLOSED') {
        throw new ConflictDomainError('This fiscal period is not closed');
      }

      const period = await tx.fiscalPeriod.update({
        where: { id: periodId },
        data: { status: 'OPEN', closedBy: null, closedAt: null },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'FiscalPeriod',
        entityId: period.id,
        before: { status: 'CLOSED' },
        after: { status: 'OPEN' },
        reason: 'Fiscal period reopened',
      });

      return period;
    });
  }
}
