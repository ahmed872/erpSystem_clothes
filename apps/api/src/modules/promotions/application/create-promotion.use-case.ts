import { Injectable } from '@nestjs/common';
import type { CreatePromotionInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { RequestUser } from '../../../common/decorators/current-user.decorator';
import { assertPromotionTargetExists, resolvePromotionWindow } from '../domain/resolve-promotion-window';

/**
 * Creates a promotion RULE. This writes configuration only - it applies
 * nothing and touches no sale. There is deliberately no endpoint anywhere
 * that applies a promotion: resolution happens server-side inside
 * `CreateSaleUseCase`'s own transaction, so a client can never supply
 * promotional pricing.
 */
@Injectable()
export class CreatePromotionUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: CreatePromotionInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      await assertPromotionTargetExists(tx, actor.tenantId, input.targetType, input.targetId);
      const window = await resolvePromotionWindow(tx, actor.tenantId, input.validFrom, input.validTo);

      const promotion = await tx.promotion.create({
        data: {
          businessId: actor.tenantId,
          name: input.name,
          type: input.type,
          targetType: input.targetType,
          targetId: input.targetId,
          percentageValue: input.type === 'PERCENTAGE' ? input.percentageValue : null,
          fixedAmount: input.type === 'FIXED_AMOUNT' ? input.fixedAmount : null,
          buyQuantity: input.type === 'BUY_X_GET_Y' ? input.buyQuantity : null,
          getQuantity: input.type === 'BUY_X_GET_Y' ? input.getQuantity : null,
          validFrom: window.validFrom,
          validTo: window.validTo,
          createdBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Promotion',
        entityId: promotion.id,
        after: promotion,
        reason: `Promotion created: ${promotion.name}`,
      });

      return { ...promotion, timezone: window.timezone };
    });
  }
}
