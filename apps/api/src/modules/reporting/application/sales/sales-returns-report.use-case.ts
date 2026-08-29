import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ReportListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { resolveReportContext } from '../../domain/report-context';
import { branchWhere } from '../../domain/branch-scope';
import { dateRangeWhere } from '../../domain/date-range';

/**
 * Sale returns as an OPERATIONAL report - what physically came back, in
 * what condition, against which sale.
 *
 * IMPORTANT (PROJECT_STATE.md Known Issue #32): for a WALK-IN return
 * (no customer), Phase 6 posts an Inventory/COGS correction but NO
 * Revenue/AR reversal, because no operational refund fact exists to post
 * one from. That means the operational return value shown here will NOT
 * always be reflected as a revenue reduction in the GL-derived P&L. The
 * response therefore surfaces `walkInReturnValue` explicitly and carries
 * a `glRevenueReversalNote`, so the divergence reads as the documented,
 * expected limitation it is - not as a reporting bug. This report never
 * re-derives a GL revenue figure from these documents.
 */
@Injectable()
export class SalesReturnsReportUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, query: ReportListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const ctx = await resolveReportContext(tx, this.effectivePermissions, actor, query);

      const where: Prisma.SaleReturnWhereInput = {
        businessId: ctx.businessId,
        createdAt: dateRangeWhere(ctx.range),
        sale: branchWhere(ctx.branchScope),
      };

      const [total, returns] = await Promise.all([
        tx.saleReturn.count({ where }),
        tx.saleReturn.findMany({
          where,
          include: {
            items: { include: { variant: { select: { id: true, sku: true, product: { select: { name: true } } } } } },
            sale: { select: { id: true, saleNumber: true, customerId: true, branchId: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      let sellableValue = new Prisma.Decimal(0);
      let damagedValue = new Prisma.Decimal(0);
      let walkInReturnValue = new Prisma.Decimal(0);
      let customerReturnValue = new Prisma.Decimal(0);

      const rows = returns.map((r) => {
        let returnValue = new Prisma.Decimal(0);
        for (const item of r.items) {
          const value = item.unitPrice.times(item.quantity);
          returnValue = returnValue.plus(value);
          if (item.condition === 'DAMAGED') damagedValue = damagedValue.plus(value);
          else sellableValue = sellableValue.plus(value);
        }
        if (r.sale.customerId) customerReturnValue = customerReturnValue.plus(returnValue);
        else walkInReturnValue = walkInReturnValue.plus(returnValue);

        return {
          id: r.id,
          returnNumber: r.returnNumber,
          saleId: r.sale.id,
          saleNumber: r.sale.saleNumber,
          isWalkIn: r.sale.customerId === null,
          returnValue: returnValue.toString(),
          createdAt: r.createdAt.toISOString(),
          items: r.items.map((i) => ({
            variantId: i.variantId,
            sku: i.variant.sku,
            productName: i.variant.product.name,
            quantity: i.quantity.toString(),
            unitPrice: i.unitPrice.toString(),
            condition: i.condition,
          })),
        };
      });

      return {
        data: rows,
        summary: {
          sellableValue: sellableValue.toString(),
          damagedValue: damagedValue.toString(),
          customerReturnValue: customerReturnValue.toString(),
          walkInReturnValue: walkInReturnValue.toString(),
          glRevenueReversalNote:
            'Walk-in returns correct Inventory and COGS in the General Ledger but do NOT reverse Sales Revenue or Accounts Receivable, because no operational refund fact is recorded for a walk-in return (documented limitation #32). The GL-derived P&L will therefore show revenue that this operational figure does not reduce. This is expected, not a discrepancy.',
        },
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
        range: { from: ctx.range.from.toISOString(), to: ctx.range.toExclusive.toISOString(), timezone: ctx.range.timezone },
      };
    });
  }
}
