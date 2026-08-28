import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/** DRAFT -> SUBMITTED. Locks further item edits; ready for approval. */
@Injectable()
export class SubmitStockCountUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, stockCountId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const stockCount = await tx.stockCount.findFirst({
        where: { id: stockCountId, businessId: actor.tenantId },
        include: { items: true },
      });
      if (!stockCount) throw new NotFoundDomainError('StockCount', stockCountId);
      if (stockCount.status !== 'DRAFT') {
        throw new ConflictDomainError(`Only a DRAFT count can be submitted (current status: ${stockCount.status})`);
      }
      if (stockCount.items.every((i) => i.actualQuantity === null)) {
        throw new ValidationFailedError('At least one item must be counted before submitting');
      }

      const updated = await tx.stockCount.update({
        where: { id: stockCountId },
        data: { status: 'SUBMITTED', submittedAt: new Date() },
        include: { items: true },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'StockCount',
        entityId: stockCountId,
        before: { status: 'DRAFT' },
        after: { status: 'SUBMITTED' },
      });

      return updated;
    });
  }
}
