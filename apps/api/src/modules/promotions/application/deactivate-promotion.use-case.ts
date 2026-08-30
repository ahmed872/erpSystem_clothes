import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

/**
 * Deactivates a promotion. It is NEVER deleted: `erp_app` holds no DELETE
 * grant on `promotions`, and a RESTRICT foreign key from
 * `sale_promotion_applications` means a promotion referenced by any
 * historical sale could not be removed even with one. Deactivation is
 * the removal mechanism, exactly as it is for Customers, Accounts and
 * Products.
 *
 * Deactivating affects FUTURE sales only - `resolveActivePromotions`
 * filters on `isActive`, and no completed sale is ever recomputed.
 */
@Injectable()
export class DeactivatePromotionUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, id: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const existing = await tx.promotion.findFirst({ where: { id, businessId: actor.tenantId } });
      if (!existing) throw new NotFoundDomainError('Promotion', id);
      if (!existing.isActive) throw new ConflictDomainError('This promotion is already inactive', { promotionId: id });

      const updated = await tx.promotion.update({ where: { id }, data: { isActive: false, updatedBy: actor.id } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Promotion',
        entityId: id,
        before: { isActive: true },
        after: { isActive: false },
        reason: 'Promotion deactivated',
      });

      return updated;
    });
  }
}
