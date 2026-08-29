import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ReportListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { resolveReportContext } from '../../domain/report-context';
import { branchWhere } from '../../domain/branch-scope';
import { dateRangeWhere } from '../../domain/date-range';
import { applyVisibility } from '../../domain/report-visibility';

/**
 * Purchasing activity for a period, measured on RECEIPTS (goods actually
 * received) rather than orders placed - the same basis Purchasing's own
 * SupplierTransaction ledger and Phase 6's GL posting use, so the three
 * always agree. Purchase VALUE is inherently cost information, so the
 * whole `totalCost` measure is gated behind `products.view_cost`.
 *
 * Note (PROJECT_STATE.md Known Issue #36): PurchaseReturn/PurchasePayment
 * have no request-level idempotency, so a retried request can create a
 * genuinely duplicate source document. This report reflects the source
 * data exactly as it is and performs NO de-duplication - hiding a real
 * duplicate would misrepresent the data.
 */
@Injectable()
export class PurchasingReportUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, query: ReportListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const ctx = await resolveReportContext(tx, this.effectivePermissions, actor, query);

      const receiptItems = await tx.purchaseReceiptItem.findMany({
        where: {
          businessId: ctx.businessId,
          purchaseReceipt: { receivedAt: dateRangeWhere(ctx.range), purchase: branchWhere(ctx.branchScope) },
        },
        select: { quantityReceived: true, unitCost: true },
      });
      const receivedValue = receiptItems.reduce((sum, i) => sum.plus(i.quantityReceived.times(i.unitCost)), new Prisma.Decimal(0));
      const receivedQuantity = receiptItems.reduce((sum, i) => sum.plus(i.quantityReceived), new Prisma.Decimal(0));

      const returnItems = await tx.purchaseReturnItem.findMany({
        where: {
          businessId: ctx.businessId,
          purchaseReturn: { createdAt: dateRangeWhere(ctx.range), purchase: branchWhere(ctx.branchScope) },
        },
        select: { quantity: true, unitCost: true },
      });
      const returnedValue = returnItems.reduce((sum, i) => sum.plus(i.quantity.times(i.unitCost)), new Prisma.Decimal(0));
      const returnedQuantity = returnItems.reduce((sum, i) => sum.plus(i.quantity), new Prisma.Decimal(0));

      const [receiptCount, returnCount, paymentAgg] = await Promise.all([
        tx.purchaseReceipt.count({
          where: { businessId: ctx.businessId, receivedAt: dateRangeWhere(ctx.range), purchase: branchWhere(ctx.branchScope) },
        }),
        tx.purchaseReturn.count({
          where: { businessId: ctx.businessId, createdAt: dateRangeWhere(ctx.range), purchase: branchWhere(ctx.branchScope) },
        }),
        tx.purchasePayment.aggregate({
          where: { businessId: ctx.businessId, paidAt: dateRangeWhere(ctx.range), purchase: branchWhere(ctx.branchScope) },
          _sum: { amount: true },
        }),
      ]);

      const summary = {
        receiptCount,
        receivedQuantity: receivedQuantity.toString(),
        returnCount,
        returnedQuantity: returnedQuantity.toString(),
        paidToSuppliers: (paymentAgg._sum.amount ?? new Prisma.Decimal(0)).toString(),
        // Cost-bearing measures - stripped for callers without products.view_cost.
        totalCost: receivedValue.toString(),
        returnedCost: returnedValue.toString(),
        netPurchaseCost: receivedValue.minus(returnedValue).toString(),
      };

      return {
        data: applyVisibility(summary, ctx.visibility),
        range: { from: ctx.range.from.toISOString(), to: ctx.range.toExclusive.toISOString(), timezone: ctx.range.timezone },
      };
    });
  }
}
