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
 * CORRECTED IN PHASE 10 (BD-23). This report previously carried a note
 * saying walk-in returns never reverse Revenue in the General Ledger -
 * true for Phases 6-9 (Known Issue #32), and now FALSE. Phase 10 records
 * the refund tender as a real operational fact at the moment the money is
 * handed back, which is precisely the condition #32 set for closing it, so
 * a walk-in return with a refund does reverse Revenue.
 *
 * `walkInReturnValue` is still surfaced, because it stays operationally
 * useful, and the note now describes the ONE case that can still diverge:
 * returns recorded BEFORE Phase 10, which carry no refund fact and were
 * posted under the old rule. Historical entries are never rewritten.
 * This report still never re-derives a GL revenue figure from these
 * documents.
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
            'Returns recorded from Phase 10 onward reverse Sales Revenue in the General Ledger, including walk-in returns, because the refund tender is now recorded as a real operational fact (this closed limitation #32). Returns recorded BEFORE Phase 10 carry no refund fact and were posted under the previous rule - a walk-in return from that period corrected Inventory and COGS but did not reduce Revenue. Historical entries are never rewritten, so that difference persists in the GL-derived P&L for older periods only, and is expected rather than a discrepancy.',
        },
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
        range: { from: ctx.range.from.toISOString(), to: ctx.range.toExclusive.toISOString(), timezone: ctx.range.timezone },
      };
    });
  }
}
