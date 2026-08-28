import { Injectable } from '@nestjs/common';
import type { CancelPurchaseInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { lockPurchase } from '../../domain/lock-purchase';

const CANCELLABLE_STATUSES = new Set(['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED']);

/**
 * Cancels a purchase. Only closes out whatever has NOT been received yet
 * - it never touches inventory or the supplier ledger for quantities
 * already received (that already-happened receiving is a fact of
 * history; if the business needs to send goods back, that's a Purchase
 * Return, not a cancellation). A fully RECEIVED purchase has nothing
 * left to cancel and is rejected; an already-CANCELLED one is rejected
 * too (no double-cancel).
 */
@Injectable()
export class CancelPurchaseUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, purchaseId: string, input: CancelPurchaseInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      await lockPurchase(tx, actor.tenantId, purchaseId);
      const purchase = await tx.purchase.findFirst({ where: { id: purchaseId, businessId: actor.tenantId } });
      if (!purchase) throw new NotFoundDomainError('Purchase', purchaseId);
      if (!CANCELLABLE_STATUSES.has(purchase.status)) {
        throw new ConflictDomainError(`Purchase cannot be cancelled from its current status: ${purchase.status}`);
      }

      const updated = await tx.purchase.update({
        where: { id: purchaseId },
        data: { status: 'CANCELLED', cancelledBy: actor.id, cancelledAt: new Date(), cancelReason: input.reason },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Purchase',
        entityId: purchaseId,
        before: { status: purchase.status },
        after: { status: 'CANCELLED' },
        reason: input.reason ?? 'Purchase cancelled',
      });

      return updated;
    });
  }
}
