import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ReportRangeQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { resolveReportContext } from '../../domain/report-context';
import { branchWhere } from '../../domain/branch-scope';
import { dateRangeWhere } from '../../domain/date-range';
import { applyVisibility } from '../../domain/report-visibility';

/**
 * Headline sales figures for a period. Read-only: issues only aggregate
 * SELECTs, never a write of any kind.
 *
 * Revenue figures come from the Sale documents themselves (the
 * operational source of truth for "what was sold"), NOT from the GL -
 * this is an operational sales report, not a financial statement. The
 * P&L (7D) is the GL-derived view and may legitimately differ; see the
 * walk-in-return divergence note in PROJECT_STATE.md Known Issue #32.
 *
 * COGS/profit here are derived from the Sale's own StockMovement rows'
 * `unitCostAtMovement` (historical, immutable), never from any current
 * product cost - and are stripped entirely for callers lacking
 * `products.view_cost` / `reports.view_profit`.
 */
@Injectable()
export class SalesSummaryUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, query: ReportRangeQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const ctx = await resolveReportContext(tx, this.effectivePermissions, actor, query);

      const where: Prisma.SaleWhereInput = {
        businessId: ctx.businessId,
        createdAt: dateRangeWhere(ctx.range),
        ...branchWhere(ctx.branchScope),
      };

      const [agg, transactionCount] = await Promise.all([
        tx.sale.aggregate({ where, _sum: { subtotal: true, discountAmount: true, taxAmount: true, totalAmount: true } }),
        tx.sale.count({ where }),
      ]);

      const subtotal = agg._sum.subtotal ?? new Prisma.Decimal(0);
      const discountAmount = agg._sum.discountAmount ?? new Prisma.Decimal(0);
      const taxAmount = agg._sum.taxAmount ?? new Prisma.Decimal(0);
      const totalAmount = agg._sum.totalAmount ?? new Prisma.Decimal(0);
      const netSales = subtotal.minus(discountAmount);

      // Returns are an OPERATIONAL metric here, sourced from SaleReturn
      // documents - deliberately not netted into the revenue figures
      // above, and never used to re-derive a GL revenue number.
      const returnAgg = await tx.saleReturnItem.aggregate({
        where: {
          businessId: ctx.businessId,
          saleReturn: { sale: { createdAt: dateRangeWhere(ctx.range), ...branchWhere(ctx.branchScope) } },
        },
        _sum: { quantity: true },
      });
      const returnedQuantity = returnAgg._sum.quantity ?? new Prisma.Decimal(0);

      const cogs = await this.computeCogs(tx, ctx.businessId, ctx.range.from, ctx.range.toExclusive, ctx.branchScope.allowedBranchIds);
      const grossProfit = netSales.minus(cogs);

      const averageInvoice = transactionCount > 0 ? totalAmount.dividedBy(transactionCount) : new Prisma.Decimal(0);

      const row = {
        subtotal: subtotal.toString(),
        discountAmount: discountAmount.toString(),
        netSales: netSales.toString(),
        taxAmount: taxAmount.toString(),
        totalAmount: totalAmount.toString(),
        transactionCount,
        averageInvoice: averageInvoice.toString(),
        returnedQuantity: returnedQuantity.toString(),
        cogs: cogs.toString(),
        grossProfit: grossProfit.toString(),
      };

      return {
        data: applyVisibility(row, ctx.visibility),
        range: { from: ctx.range.from.toISOString(), to: ctx.range.toExclusive.toISOString(), timezone: ctx.range.timezone },
      };
    });
  }

  /** SUM(|quantityBase| x unitCostAtMovement) over this period's SALE and
   * BUNDLE_CONSUMPTION movements - the same historical-cost basis Phase 5's
   * computeSaleCost uses, never a current cost. */
  private async computeCogs(
    tx: Prisma.TransactionClient,
    businessId: string,
    from: Date,
    toExclusive: Date,
    allowedBranchIds: string[] | null,
  ): Promise<Prisma.Decimal> {
    const movements = await tx.stockMovement.findMany({
      where: {
        businessId,
        referenceType: 'Sale',
        movementType: { in: ['SALE', 'BUNDLE_CONSUMPTION'] },
        createdAt: { gte: from, lt: toExclusive },
        ...(allowedBranchIds === null ? {} : { branchId: { in: allowedBranchIds } }),
      },
      select: { quantityBase: true, unitCostAtMovement: true },
    });
    return movements.reduce((sum, m) => sum.plus(m.quantityBase.abs().times(m.unitCostAtMovement)), new Prisma.Decimal(0));
  }
}
