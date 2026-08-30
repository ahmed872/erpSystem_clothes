import { Injectable } from '@nestjs/common';
import type { UpdatePromotionInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';
import { resolvePromotionWindow } from '../domain/resolve-promotion-window';

/**
 * Edits a promotion's name, validity window or active flag - and nothing
 * else.
 *
 * Type, target and parameters are deliberately NOT editable: a historical
 * `SalePromotionApplication` stores the promotionId alongside the type
 * and name AT THE TIME OF SALE, so repurposing a rule in place would make
 * those rows point at something that no longer resembles what actually
 * happened. A different rule is a different promotion.
 *
 * Editing affects FUTURE sales only. No historical Sale is ever
 * recomputed from the edited row - what a completed sale received is
 * frozen in its own `SaleItem.discountAmount` snapshot and described by
 * its append-only application row.
 */
@Injectable()
export class UpdatePromotionUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, id: string, input: UpdatePromotionInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const existing = await tx.promotion.findFirst({ where: { id, businessId: actor.tenantId } });
      if (!existing) throw new NotFoundDomainError('Promotion', id);

      let validFrom = existing.validFrom;
      let validTo = existing.validTo;
      if (input.validFrom !== undefined || input.validTo !== undefined) {
        // Both bounds are re-resolved together so a partial change can
        // never produce an inverted window that only the CHECK catches.
        const fromDate = input.validFrom ?? toCalendarDate(existing.validFrom);
        const toDate = input.validTo ?? toCalendarDate(new Date(existing.validTo.getTime() - 1));
        const window = await resolvePromotionWindow(tx, actor.tenantId, fromDate, toDate);
        validFrom = window.validFrom;
        validTo = window.validTo;
      }

      const updated = await tx.promotion.update({
        where: { id },
        data: { name: input.name, isActive: input.isActive, validFrom, validTo, updatedBy: actor.id },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Promotion',
        entityId: id,
        before: existing,
        after: updated,
        reason: 'Promotion updated',
      });

      return updated;
    });
  }
}

/** The stored instant back to a `YYYY-MM-DD` string, so an unchanged
 * bound round-trips through the same timezone resolution as a supplied
 * one rather than being re-interpreted differently. */
function toCalendarDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}
