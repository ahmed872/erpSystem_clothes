import { Injectable } from '@nestjs/common';
import type { OpenPeriodInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Creates a new FiscalPeriod. Non-overlap is checked only against OTHER
 * OPEN periods (an application-level check, not a DB exclusion
 * constraint - see PROJECT_STATE.md Known Issues) - a CLOSED period's
 * date range never blocks a new one from being opened over it. This is
 * deliberate, not an oversight: the standard "close this period, open
 * the next one" workflow requires it. Every business starts with exactly
 * one open-ended bootstrap period (see seedAccountingDefaults) covering
 * every future date - if closing it also permanently blocked the date
 * range it used to cover, no business could ever open a second period
 * again after its first close. Two SIMULTANEOUSLY OPEN periods covering
 * the same date, however, is genuinely ambiguous (which one does
 * postEntry pick?) and is correctly still rejected.
 */
@Injectable()
export class OpenPeriodUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: OpenPeriodInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const overlapping = await tx.fiscalPeriod.findFirst({
        where: {
          businessId: actor.tenantId,
          status: 'OPEN',
          startDate: { lte: input.endDate },
          endDate: { gte: input.startDate },
        },
      });
      if (overlapping) {
        throw new ConflictDomainError('This date range overlaps an existing OPEN fiscal period', { overlappingPeriodId: overlapping.id });
      }

      const period = await tx.fiscalPeriod.create({
        data: {
          businessId: actor.tenantId,
          name: input.name,
          startDate: input.startDate,
          endDate: input.endDate,
          status: 'OPEN',
          createdBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'FiscalPeriod',
        entityId: period.id,
        after: period,
      });

      return period;
    });
  }
}
