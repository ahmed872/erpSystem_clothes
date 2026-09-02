import { Injectable } from '@nestjs/common';
import { AccountingMappingKey, Prisma } from '@prisma/client';
import type { ReportRangeQuery } from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { ReportContext, resolveReportContext } from '../../domain/report-context';
import { branchWhere } from '../../domain/branch-scope';
import { dateRangeWhere } from '../../domain/date-range';
import { applyVisibility, applyVisibilityToRows } from '../../domain/report-visibility';

/**
 * The dashboard is a PURE READ MODEL - a live aggregate over the
 * source-of-truth systems, computed on every request. Phase 7
 * deliberately creates NO dashboard tables and NO cached/materialised
 * financial figures: a duplicated financial truth that can drift is worse
 * than a slightly slower query, and there is no measured performance
 * problem to justify one. Indexing (see the reporting-indexes migration)
 * is the performance lever instead.
 *
 * All the aggregates run inside ONE transaction so the KPIs form a
 * consistent snapshot rather than a mix of instants.
 *
 * Honest labelling matters here more than anywhere else in the reporting
 * layer, because a dashboard number is read without context:
 *   - `inventoryRelatedOperatingExpenses` is NOT total business expenses
 *     (no expense module exists). It is never labelled "Total Expenses".
 *   - `netProfit` inherits that same limitation and says so.
 *   - `cashBalance`/`bankBalance` are GL account balances reflecting
 *     RECORDED activity only - there is no cash deposit/withdrawal or
 *     owner-drawings capability, so they are not a full treasury position.
 *   - Low Stock is absent entirely: no reorder-point field exists.
 */
@Injectable()
export class DashboardUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, query: ReportRangeQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const ctx = await resolveReportContext(tx, this.effectivePermissions, actor, query);
      const saleWhere: Prisma.SaleWhereInput = {
        businessId: ctx.businessId,
        createdAt: dateRangeWhere(ctx.range),
        ...branchWhere(ctx.branchScope),
      };

      const [salesAgg, transactionCount, purchaseItems, cogs, inventoryValue, topProducts, slowProducts, glBalances] = await Promise.all([
        tx.sale.aggregate({ where: saleWhere, _sum: { subtotal: true, discountAmount: true, taxAmount: true, totalAmount: true } }),
        tx.sale.count({ where: saleWhere }),
        tx.purchaseReceiptItem.findMany({
          where: { businessId: ctx.businessId, purchaseReceipt: { receivedAt: dateRangeWhere(ctx.range), purchase: branchWhere(ctx.branchScope) } },
          select: { quantityReceived: true, unitCost: true },
        }),
        this.periodCogs(tx, ctx),
        this.inventoryValue(tx, ctx),
        this.topProducts(tx, ctx, 'desc'),
        this.topProducts(tx, ctx, 'asc'),
        this.glBalances(tx, ctx),
      ]);

      const subtotal = salesAgg._sum.subtotal ?? new Prisma.Decimal(0);
      const discountAmount = salesAgg._sum.discountAmount ?? new Prisma.Decimal(0);
      const totalAmount = salesAgg._sum.totalAmount ?? new Prisma.Decimal(0);
      const netSales = subtotal.minus(discountAmount);
      const purchases = purchaseItems.reduce((s, i) => s.plus(i.quantityReceived.times(i.unitCost)), new Prisma.Decimal(0));
      const grossProfit = netSales.minus(cogs);
      const netProfit = grossProfit.minus(glBalances.inventoryRelatedExpenses).plus(glBalances.otherIncome);

      const kpis = {
        sales: totalAmount.toString(),
        netSales: netSales.toString(),
        discounts: discountAmount.toString(),
        transactions: transactionCount,
        averageInvoice: (transactionCount > 0 ? totalAmount.dividedBy(transactionCount) : new Prisma.Decimal(0)).toString(),
        totalCost: purchases.toString(),
        cogs: cogs.toString(),
        grossProfit: grossProfit.toString(),
        netProfit: netProfit.toString(),
        inventoryValue: inventoryValue.toString(),
        receivables: glBalances.receivables.toString(),
        payables: glBalances.payables.toString(),
        cashBalance: glBalances.cash.toString(),
        bankBalance: glBalances.bank.toString(),
        inventoryRelatedOperatingExpenses: glBalances.inventoryRelatedExpenses.toString(),
      };

      return {
        data: {
          kpis: applyVisibility(kpis, ctx.visibility),
          topProducts: applyVisibilityToRows(topProducts, ctx.visibility),
          slowestProducts: applyVisibilityToRows(slowProducts, ctx.visibility),
        },
        limitations: {
          expenses:
            'inventoryRelatedOperatingExpenses covers ONLY inventory shrinkage and internal consumption. No expense-management module exists, so rent, salaries, utilities and similar business costs are NOT included. This is not a total-expenses figure.',
          netProfit: 'netProfit inherits the expense limitation above and is therefore not a complete business profit figure.',
          cashAndBank:
            'cashBalance and bankBalance are General Ledger account balances reflecting recorded sales/purchase activity only. There is no cash deposit, withdrawal, or owner-drawings capability, so these are not a complete treasury position.',
          lowStock: 'A Low Stock KPI is not available: no reorder-point or minimum-stock threshold field exists to define "low".',
          loyaltyPoints:
            'Loyalty points post no General Ledger fact when earned, so netRevenue and netProfit reflect redemptions (a discount on the redeeming sale) but never an accrual for points still outstanding. Outstanding loyalty points are measurable through the append-only CustomerPoints ledger but are NOT represented as a General Ledger liability during the controlled pilot.',
        },
        range: { from: ctx.range.from.toISOString(), to: ctx.range.toExclusive.toISOString(), timezone: ctx.range.timezone },
      };
    });
  }

  private async periodCogs(tx: TenantTx, ctx: ReportContext): Promise<Prisma.Decimal> {
    const movements = await tx.stockMovement.findMany({
      where: {
        businessId: ctx.businessId,
        referenceType: 'Sale',
        movementType: { in: ['SALE', 'BUNDLE_CONSUMPTION'] },
        createdAt: dateRangeWhere(ctx.range),
        ...branchWhere(ctx.branchScope),
      },
      select: { quantityBase: true, unitCostAtMovement: true },
    });
    return movements.reduce((s, m) => s.plus(m.quantityBase.abs().times(m.unitCostAtMovement)), new Prisma.Decimal(0));
  }

  private async inventoryValue(tx: TenantTx, ctx: ReportContext): Promise<Prisma.Decimal> {
    const warehouseFilter = ctx.branchScope.allowedBranchIds === null ? undefined : { branchId: { in: ctx.branchScope.allowedBranchIds } };
    const balances = await tx.stockBalance.findMany({
      where: { businessId: ctx.businessId, ...(warehouseFilter ? { warehouse: warehouseFilter } : {}) },
      select: { quantityOnHand: true, averageCost: true },
    });
    return balances.reduce((s, b) => s.plus(b.quantityOnHand.times(b.averageCost)), new Prisma.Decimal(0));
  }

  private async topProducts(tx: TenantTx, ctx: ReportContext, direction: 'asc' | 'desc') {
    const items = await tx.saleItem.findMany({
      where: { businessId: ctx.businessId, sale: { createdAt: dateRangeWhere(ctx.range), ...branchWhere(ctx.branchScope) } },
      select: {
        variantId: true,
        quantity: true,
        unitPrice: true,
        discountAmount: true,
        variant: { select: { sku: true, product: { select: { name: true } } } },
      },
    });

    const acc = new Map<string, { label: string; sku: string; quantity: Prisma.Decimal; netSales: Prisma.Decimal }>();
    for (const i of items) {
      const current = acc.get(i.variantId) ?? {
        label: i.variant.product.name,
        sku: i.variant.sku,
        quantity: new Prisma.Decimal(0),
        netSales: new Prisma.Decimal(0),
      };
      current.quantity = current.quantity.plus(i.quantity);
      current.netSales = current.netSales.plus(i.unitPrice.times(i.quantity).minus(i.discountAmount));
      acc.set(i.variantId, current);
    }

    return [...acc.entries()]
      .map(([variantId, v]) => ({ variantId, sku: v.sku, productName: v.label, quantity: v.quantity.toString(), netSales: v.netSales.toString() }))
      .sort((a, b) => (direction === 'desc' ? Number(b.netSales) - Number(a.netSales) : Number(a.netSales) - Number(b.netSales)))
      .slice(0, 5);
  }

  /**
   * Balance-type KPIs are "as at now" positions, not period flows, so
   * they are deliberately NOT date-filtered - a receivable does not stop
   * being owed because the report window ended.
   */
  private async glBalances(tx: TenantTx, ctx: ReportContext) {
    const rules = await tx.accountingMappingRule.findMany({ where: { businessId: ctx.businessId }, select: { key: true, accountId: true } });
    const byKey = new Map<AccountingMappingKey, string>(rules.map((r) => [r.key, r.accountId]));

    const grouped = await tx.journalEntryLine.groupBy({
      by: ['accountId'],
      where: { businessId: ctx.businessId },
      _sum: { debit: true, credit: true },
    });
    const sums = new Map(grouped.map((g) => [g.accountId, g._sum]));

    const debitNormal = (key: AccountingMappingKey) => {
      const id = byKey.get(key);
      if (!id) return new Prisma.Decimal(0);
      const s = sums.get(id);
      return (s?.debit ?? new Prisma.Decimal(0)).minus(s?.credit ?? new Prisma.Decimal(0));
    };
    const creditNormal = (key: AccountingMappingKey) => {
      const id = byKey.get(key);
      if (!id) return new Prisma.Decimal(0);
      const s = sums.get(id);
      return (s?.credit ?? new Prisma.Decimal(0)).minus(s?.debit ?? new Prisma.Decimal(0));
    };

    return {
      cash: debitNormal('TENDER_CASH'),
      bank: debitNormal('TENDER_BANK_TRANSFER'),
      receivables: debitNormal('ACCOUNTS_RECEIVABLE'),
      payables: creditNormal('ACCOUNTS_PAYABLE'),
      inventoryRelatedExpenses: debitNormal('INVENTORY_SHRINKAGE').plus(debitNormal('INTERNAL_CONSUMPTION_EXPENSE')),
      otherIncome: creditNormal('INVENTORY_GAIN'),
    };
  }
}
