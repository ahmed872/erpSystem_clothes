import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { lockPurchase } from '../../domain/lock-purchase';

/**
 * DRAFT -> APPROVED. Approval is deliberately a separate step from
 * receiving (a documented refinement beyond Phase 0's one-line
 * description, required by this phase's partial/multiple-receiving and
 * over-receiving-prevention rules) - it commits the business to the
 * order but has NO inventory or supplier-ledger effect of its own; those
 * only happen at receiving time.
 */
@Injectable()
export class ApprovePurchaseUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, purchaseId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      await lockPurchase(tx, actor.tenantId, purchaseId);
      const purchase = await tx.purchase.findFirst({ where: { id: purchaseId, businessId: actor.tenantId }, include: { items: true } });
      if (!purchase) throw new NotFoundDomainError('Purchase', purchaseId);
      if (purchase.status !== 'DRAFT') {
        throw new ConflictDomainError(`Only a DRAFT purchase can be approved (current status: ${purchase.status})`);
      }
      if (purchase.items.length === 0) {
        throw new ConflictDomainError('Cannot approve a purchase with no items');
      }

      const updated = await tx.purchase.update({
        where: { id: purchaseId },
        data: { status: 'APPROVED', approvedBy: actor.id, approvedAt: new Date() },
        include: { items: true },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Purchase',
        entityId: purchaseId,
        before: { status: 'DRAFT' },
        after: { status: 'APPROVED' },
        reason: 'Purchase approved',
      });

      return updated;
    });
  }
}
