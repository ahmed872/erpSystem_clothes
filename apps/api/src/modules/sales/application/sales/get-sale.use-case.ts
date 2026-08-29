import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { computeSaleCost } from '../../domain/sale-cost';
import { computePaymentSummary } from '../../domain/payment-summary';

/**
 * COGS/margin fields (`totalCost`, `grossProfit`) are only ever attached
 * for a caller holding `products.view_cost` - a Cashier never sees them,
 * server-side enforced, exactly applying the Phase 4 review's lesson
 * (Known Issue #25) to the domain where the spec explicitly requires it
 * (Phase 0 §9: Cashier "بدون رؤية التكلفة/الربح").
 */
@Injectable()
export class GetSaleUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, saleId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, businessId: actor.tenantId },
        include: {
          customer: { select: { id: true, name: true } },
          shift: { select: { id: true, openedBy: true, openedAt: true } },
          items: { include: { variant: { select: { id: true, sku: true } } } },
          payments: { orderBy: { receivedAt: 'desc' } },
          returns: { include: { items: true }, orderBy: { createdAt: 'desc' } },
        },
      });
      if (!sale) throw new NotFoundDomainError('Sale', saleId);

      const { paidAmount, remainingAmount, paymentStatus } = await computePaymentSummary(tx, actor.tenantId, sale);
      const withPaymentSummary = {
        ...sale,
        paidAmount: paidAmount.toString(),
        remainingAmount: remainingAmount.toString(),
        paymentStatus,
      };

      const permissions = await this.effectivePermissions.get(tx, actor.id);
      if (!(permissions?.has('products.view_cost') ?? false)) {
        return withPaymentSummary;
      }

      const { totalCost, grossProfit } = await computeSaleCost(tx, actor.tenantId, sale);
      return { ...withPaymentSummary, totalCost: totalCost.toString(), grossProfit: grossProfit.toString() };
    });
  }
}
