import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { SalesByDimensionQuery } from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { ReportContext, resolveReportContext } from '../../domain/report-context';
import { branchWhere } from '../../domain/branch-scope';
import { dateRangeWhere } from '../../domain/date-range';
import { applyVisibilityToRows } from '../../domain/report-visibility';

interface DimensionRow {
  key: string;
  label: string;
  quantity: string;
  netSales: string;
  cogs: string;
  grossProfit: string;
  transactionCount?: number;
}

/**
 * Sales broken down by product, category, branch, user, or payment
 * method. One use-case rather than five near-identical ones, because the
 * only thing that varies is which key each SaleItem/Sale is grouped by -
 * the period filter, branch authorization, cost basis and field
 * visibility are identical across all of them, and duplicating those four
 * concerns five times is exactly how one of them eventually gets missed.
 *
 * Cost/profit per dimension uses the SALE/BUNDLE_CONSUMPTION
 * StockMovement rows' historical `unitCostAtMovement`, never a current
 * product cost, and is stripped for callers lacking the permissions.
 */
@Injectable()
export class SalesByDimensionUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, dimension: 'product' | 'category' | 'branch' | 'user' | 'paymentMethod', query: SalesByDimensionQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const ctx = await resolveReportContext(tx, this.effectivePermissions, actor, query);

      const rows =
        dimension === 'paymentMethod'
          ? await this.byPaymentMethod(tx, ctx)
          : dimension === 'branch'
            ? await this.byBranch(tx, ctx)
            : dimension === 'user'
              ? await this.byUser(tx, ctx)
              : await this.byProductOrCategory(tx, ctx, dimension, query.warehouseId);

      const sorted = rows.sort((a, b) => Number(b.netSales) - Number(a.netSales));
      const start = (query.page - 1) * query.limit;
      const pageRows = sorted.slice(start, start + query.limit);

      return {
        data: applyVisibilityToRows(pageRows, ctx.visibility),
        pagination: { page: query.page, limit: query.limit, total: sorted.length, totalPages: Math.ceil(sorted.length / query.limit) },
        range: { from: ctx.range.from.toISOString(), to: ctx.range.toExclusive.toISOString(), timezone: ctx.range.timezone },
      };
    });
  }

  private saleWhere(ctx: ReportContext): Prisma.SaleWhereInput {
    return { businessId: ctx.businessId, createdAt: dateRangeWhere(ctx.range), ...branchWhere(ctx.branchScope) };
  }

  /** Per-variant COGS for the period, keyed by variantId. */
  private async cogsByVariant(tx: TenantTx, ctx: ReportContext): Promise<Map<string, Prisma.Decimal>> {
    const movements = await tx.stockMovement.findMany({
      where: {
        businessId: ctx.businessId,
        referenceType: 'Sale',
        movementType: { in: ['SALE', 'BUNDLE_CONSUMPTION'] },
        createdAt: dateRangeWhere(ctx.range),
        ...branchWhere(ctx.branchScope),
      },
      select: { variantId: true, quantityBase: true, unitCostAtMovement: true },
    });
    const map = new Map<string, Prisma.Decimal>();
    for (const m of movements) {
      const value = m.quantityBase.abs().times(m.unitCostAtMovement);
      map.set(m.variantId, (map.get(m.variantId) ?? new Prisma.Decimal(0)).plus(value));
    }
    return map;
  }

  private async byProductOrCategory(tx: TenantTx, ctx: ReportContext, dimension: 'product' | 'category', warehouseId?: string): Promise<DimensionRow[]> {
    const items = await tx.saleItem.findMany({
      where: {
        businessId: ctx.businessId,
        sale: { ...this.saleWhere(ctx), ...(warehouseId ? { warehouseId } : {}) },
      },
      select: {
        variantId: true,
        quantity: true,
        unitPrice: true,
        discountAmount: true,
        variant: { select: { id: true, sku: true, product: { select: { name: true, categoryId: true, category: { select: { name: true } } } } } },
      },
    });

    const cogsMap = await this.cogsByVariant(tx, ctx);
    const acc = new Map<string, { label: string; quantity: Prisma.Decimal; netSales: Prisma.Decimal; cogs: Prisma.Decimal }>();

    for (const item of items) {
      const lineNet = item.unitPrice.times(item.quantity).minus(item.discountAmount);
      const key =
        dimension === 'product'
          ? item.variantId
          : // `Product.categoryId` is nullable (onDelete: SetNull), so an
            // explicit bucket is used rather than silently dropping those
            // rows - a dropped row would make category totals disagree
            // with the sales summary for no visible reason.
            (item.variant.product.categoryId ?? 'uncategorized');
      const label =
        dimension === 'product'
          ? `${item.variant.product.name} (${item.variant.sku})`
          : (item.variant.product.category?.name ?? 'Uncategorized');

      const current = acc.get(key) ?? { label, quantity: new Prisma.Decimal(0), netSales: new Prisma.Decimal(0), cogs: new Prisma.Decimal(0) };
      current.quantity = current.quantity.plus(item.quantity);
      current.netSales = current.netSales.plus(lineNet);
      if (dimension === 'product') {
        current.cogs = cogsMap.get(item.variantId) ?? new Prisma.Decimal(0);
      } else {
        current.cogs = current.cogs.plus(cogsMap.get(item.variantId) ?? new Prisma.Decimal(0));
      }
      acc.set(key, current);
    }

    return [...acc.entries()].map(([key, v]) => ({
      key,
      label: v.label,
      quantity: v.quantity.toString(),
      netSales: v.netSales.toString(),
      cogs: v.cogs.toString(),
      grossProfit: v.netSales.minus(v.cogs).toString(),
    }));
  }

  private async byBranch(tx: TenantTx, ctx: ReportContext): Promise<DimensionRow[]> {
    const grouped = await tx.sale.groupBy({
      by: ['branchId'],
      where: this.saleWhere(ctx),
      _sum: { subtotal: true, discountAmount: true },
      _count: { _all: true },
    });
    const branches = await tx.branch.findMany({ where: { businessId: ctx.businessId }, select: { id: true, name: true } });
    const nameById = new Map(branches.map((b) => [b.id, b.name]));

    const cogsMap = await this.cogsByBranch(tx, ctx);
    return grouped.map((g) => {
      const netSales = (g._sum.subtotal ?? new Prisma.Decimal(0)).minus(g._sum.discountAmount ?? new Prisma.Decimal(0));
      const cogs = cogsMap.get(g.branchId) ?? new Prisma.Decimal(0);
      return {
        key: g.branchId,
        label: nameById.get(g.branchId) ?? g.branchId,
        quantity: '0',
        netSales: netSales.toString(),
        cogs: cogs.toString(),
        grossProfit: netSales.minus(cogs).toString(),
        transactionCount: g._count._all,
      };
    });
  }

  private async cogsByBranch(tx: TenantTx, ctx: ReportContext): Promise<Map<string, Prisma.Decimal>> {
    const movements = await tx.stockMovement.findMany({
      where: {
        businessId: ctx.businessId,
        referenceType: 'Sale',
        movementType: { in: ['SALE', 'BUNDLE_CONSUMPTION'] },
        createdAt: dateRangeWhere(ctx.range),
        ...branchWhere(ctx.branchScope),
      },
      select: { branchId: true, quantityBase: true, unitCostAtMovement: true },
    });
    const map = new Map<string, Prisma.Decimal>();
    for (const m of movements) {
      const value = m.quantityBase.abs().times(m.unitCostAtMovement);
      map.set(m.branchId, (map.get(m.branchId) ?? new Prisma.Decimal(0)).plus(value));
    }
    return map;
  }

  private async byUser(tx: TenantTx, ctx: ReportContext): Promise<DimensionRow[]> {
    const grouped = await tx.sale.groupBy({
      by: ['createdBy'],
      where: this.saleWhere(ctx),
      _sum: { subtotal: true, discountAmount: true },
      _count: { _all: true },
    });
    const userIds = grouped.map((g) => g.createdBy).filter((id): id is string => id !== null);
    const users = await tx.user.findMany({ where: { id: { in: userIds }, businessId: ctx.businessId }, select: { id: true, name: true } });
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    return grouped.map((g) => {
      const netSales = (g._sum.subtotal ?? new Prisma.Decimal(0)).minus(g._sum.discountAmount ?? new Prisma.Decimal(0));
      return {
        // `Sale.createdBy` is nullable - surfaced explicitly rather than
        // dropped, so totals always reconcile with the sales summary.
        key: g.createdBy ?? 'unattributed',
        label: g.createdBy ? (nameById.get(g.createdBy) ?? g.createdBy) : 'Unattributed',
        quantity: '0',
        netSales: netSales.toString(),
        cogs: '0',
        grossProfit: '0',
        transactionCount: g._count._all,
      };
    });
  }

  private async byPaymentMethod(tx: TenantTx, ctx: ReportContext): Promise<DimensionRow[]> {
    const grouped = await tx.salePayment.groupBy({
      by: ['method'],
      where: {
        businessId: ctx.businessId,
        receivedAt: dateRangeWhere(ctx.range),
        sale: branchWhere(ctx.branchScope),
      },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return grouped.map((g) => ({
      key: g.method,
      label: g.method,
      quantity: '0',
      // For payments the meaningful measure is the amount COLLECTED, not
      // a net-sales figure - a credit sale's payment can arrive in a
      // different period than the sale itself.
      netSales: (g._sum.amount ?? new Prisma.Decimal(0)).toString(),
      cogs: '0',
      grossProfit: '0',
      transactionCount: g._count._all,
    }));
  }
}
