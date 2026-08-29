import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Closes the acting user's currently open shift. Uses a single
 * conditional UPDATE (`WHERE status = 'OPEN'`) rather than a separate
 * read-then-write, so two concurrent close attempts for the same shift
 * cannot both report success: Postgres serializes the two UPDATEs via
 * its normal row-level locking, and only the first to commit actually
 * matches the WHERE clause - the second's updateMany affects 0 rows,
 * which we detect and reject rather than silently reporting success.
 */
@Injectable()
export class CloseShiftUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const openShift = await tx.shift.findFirst({ where: { businessId: actor.tenantId, openedBy: actor.id, status: 'OPEN' } });
      if (!openShift) {
        throw new ConflictDomainError('You have no open shift to close');
      }

      const result = await tx.shift.updateMany({
        where: { id: openShift.id, status: 'OPEN' },
        data: { status: 'CLOSED', closedBy: actor.id, closedAt: new Date() },
      });
      if (result.count === 0) {
        throw new ConflictDomainError('This shift was already closed');
      }

      const closed = await tx.shift.findUniqueOrThrow({ where: { id: openShift.id } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Shift',
        entityId: closed.id,
        before: { status: 'OPEN' },
        after: { status: 'CLOSED' },
        reason: 'Shift closed',
      });

      return closed;
    });
  }
}
