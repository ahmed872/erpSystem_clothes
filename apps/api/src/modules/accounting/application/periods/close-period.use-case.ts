import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { lockFiscalPeriodById } from '../../domain/lock-fiscal-period';

/**
 * Closes a fiscal period. Locks the SAME row AccountingEngineService.
 * postEntry locks before validating status='OPEN' (see
 * lockFiscalPeriodById's doc comment) - the period-close-vs-posting
 * concurrency guarantee: whichever side acquires the lock first commits
 * first, the other either sees the just-closed status (rejected) or
 * blocks until the in-flight posting commits before it can close.
 */
@Injectable()
export class ClosePeriodUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, periodId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const locked = await lockFiscalPeriodById(tx, actor.tenantId, periodId);
      if (locked.status !== 'OPEN') {
        throw new ConflictDomainError('This fiscal period is already closed');
      }

      const period = await tx.fiscalPeriod.update({
        where: { id: periodId },
        data: { status: 'CLOSED', closedBy: actor.id, closedAt: new Date() },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'FiscalPeriod',
        entityId: period.id,
        before: { status: 'OPEN' },
        after: { status: 'CLOSED' },
        reason: 'Fiscal period closed',
      });

      return period;
    });
  }
}
