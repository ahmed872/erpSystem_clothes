import { Injectable } from '@nestjs/common';
import { AccountingMappingKey, Prisma } from '@prisma/client';
import type { BalanceSheetQuery, GeneralLedgerQuery, ReceivablesQuery, ReportRangeQuery } from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { ForbiddenDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { resolveReportContext } from '../../domain/report-context';
import { dateRangeWhere } from '../../domain/date-range';

/**
 * Financial reports. The ONLY source of truth here is POSTED
 * JournalEntryLine rows - never Sale/Purchase documents, never a
 * re-derived accounting fact. Phase 6 already guarantees every entry is
 * balanced (application check + deferred DB trigger), which is what makes
 * the Balance Sheet identity below provable rather than approximate.
 *
 * Deliberately NOT implemented (documented Phase 7 scope decisions):
 *   - IAS-7 Cash Flow Statement: Investing and Financing have no source
 *     data at all (no fixed assets, loans, or capital transactions exist
 *     in the system), so a three-section statement cannot be produced
 *     correctly. Showing those sections as zero would falsely imply "no
 *     such activity" when the truth is "cannot be recorded". DEFERRED.
 *   - AR/AP aging buckets: no due-date/payment-terms field exists.
 *     Plain balances only. BLOCKED BY DEPENDENCY.
 *   - A loyalty-points liability: points are earned and redeemed entirely
 *     in the append-only CustomerPoints ledger and post NO journal entry,
 *     so no GL fact backs a liability line and inventing one here would
 *     be exactly the "re-derive an accounting fact from documents" this
 *     class refuses to do everywhere else. Accepted for the controlled
 *     pilot and stated in `limitations` on both statements it affects
 *     (P&L timing, Balance Sheet liabilities) rather than left implicit.
 *
 * Note on branch scope: the Chart of Accounts is business-scoped (Phase 6
 * decision - Account has no branchId), so financial statements are
 * inherently business-wide. Access is therefore gated by
 * `reports.financial.view`, which is exactly the permission that marks a
 * caller as branch-unrestricted (see branch-scope.ts).
 */
@Injectable()
export class FinancialReportsUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async generalLedger(actor: RequestUser, query: GeneralLedgerQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const ctx = await resolveReportContext(tx, this.effectivePermissions, actor, query);

      const where: Prisma.JournalEntryLineWhereInput = {
        businessId: ctx.businessId,
        journalEntry: { entryDate: dateRangeWhere(ctx.range) },
        ...(query.accountId ? { accountId: query.accountId } : {}),
      };

      const [total, lines] = await Promise.all([
        tx.journalEntryLine.count({ where }),
        tx.journalEntryLine.findMany({
          where,
          include: {
            account: { select: { code: true, name: true, type: true } },
            journalEntry: { select: { entryNumber: true, entryDate: true, sourceType: true, sourceId: true, description: true } },
          },
          orderBy: [{ journalEntry: { entryDate: 'desc' } }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      return {
        data: lines.map((l) => ({
          journalEntryId: l.journalEntryId,
          entryNumber: l.journalEntry.entryNumber,
          entryDate: l.journalEntry.entryDate.toISOString(),
          sourceType: l.journalEntry.sourceType,
          sourceId: l.journalEntry.sourceId,
          accountId: l.accountId,
          accountCode: l.account.code,
          accountName: l.account.name,
          accountType: l.account.type,
          debit: l.debit.toString(),
          credit: l.credit.toString(),
          description: l.description ?? l.journalEntry.description,
        })),
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
        range: { from: ctx.range.from.toISOString(), to: ctx.range.toExclusive.toISOString(), timezone: ctx.range.timezone },
      };
    });
  }

  /**
   * P&L for a period, derived entirely from posted journal lines.
   *
   * Revenue is reported NET (Phase 7 decision: keep net revenue). Phase 6
   * posts a sale return's revenue reversal as a DEBIT to the same Sales
   * Revenue account rather than to a separate contra-revenue account, so
   * a gross/returns split is not derivable from the GL - and deriving it
   * from SaleReturn documents instead would re-derive an accounting fact
   * from invoices, which is forbidden.
   *
   * Discounts deliberately do NOT appear: Phase 6 posts revenue already
   * net of discount, so no GL fact backs a discount line. Discounts are a
   * Sales-report metric only.
   */
  async profitAndLoss(actor: RequestUser, query: ReportRangeQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const ctx = await resolveReportContext(tx, this.effectivePermissions, actor, query);
      const balances = await this.accountBalances(tx, ctx.businessId, { entryDate: dateRangeWhere(ctx.range) });
      const mapped = await this.mappedAccountIds(tx, ctx.businessId);

      const revenue = this.sumForAccount(balances, mapped.get('SALES_REVENUE'), 'CREDIT');
      const otherIncome = this.sumForAccount(balances, mapped.get('INVENTORY_GAIN'), 'CREDIT');
      const cogs = this.sumForAccount(balances, mapped.get('COGS'), 'DEBIT');
      const shrinkage = this.sumForAccount(balances, mapped.get('INVENTORY_SHRINKAGE'), 'DEBIT');
      const internalConsumption = this.sumForAccount(balances, mapped.get('INTERNAL_CONSUMPTION_EXPENSE'), 'DEBIT');

      const grossProfit = revenue.minus(cogs);
      const operatingExpenses = shrinkage.plus(internalConsumption);
      const netProfit = grossProfit.minus(operatingExpenses).plus(otherIncome);

      return {
        data: {
          netRevenue: revenue.toString(),
          costOfGoodsSold: cogs.toString(),
          grossProfit: grossProfit.toString(),
          inventoryRelatedOperatingExpenses: {
            inventoryShrinkage: shrinkage.toString(),
            internalConsumption: internalConsumption.toString(),
            total: operatingExpenses.toString(),
          },
          otherIncome: otherIncome.toString(),
          netProfit: netProfit.toString(),
        },
        limitations: {
          revenueBasis:
            'Revenue is reported NET of sale returns. Phase 6 posts a return\'s revenue reversal as a debit to the same Sales Revenue account, so a gross-revenue / returns split is not derivable from the General Ledger.',
          operatingExpensesScope:
            'Operating expenses here are INVENTORY-RELATED ONLY (shrinkage, internal consumption). No expense-management module exists, so rent, salaries, utilities and similar costs cannot be recorded and are NOT represented. Net Profit carries the same limitation and is not a complete business profit figure.',
          discounts: 'Discounts are not a P&L line: revenue is posted already net of discount, so no General Ledger fact backs a separate discount figure. See the sales reports for discount metrics.',
          walkInReturns:
            'Walk-in (no-customer) sale returns DO reverse revenue from Phase 10 onward, because the refund tender handed back is recorded as a real operational fact (this closed limitation #32). Walk-in returns recorded BEFORE Phase 10 carry no refund fact and did not reduce revenue; those historical entries are never rewritten, so periods spanning that change may show the older treatment.',
          loyaltyPoints:
            'Loyalty points are recognised on REDEMPTION, not on earning. Earning posts no General Ledger fact, so nothing is accrued in the period a point was earned; redeeming applies a line discount, so revenue in the redeeming period is already net of it. Net Revenue and Net Profit therefore carry a timing mismatch between the period that earned a point and the period that honoured it. Outstanding loyalty points are measurable through the append-only CustomerPoints ledger (the balance is SUM(points) per customer) but are NOT represented as a General Ledger liability during the controlled pilot.',
        },
        range: { from: ctx.range.from.toISOString(), to: ctx.range.toExclusive.toISOString(), timezone: ctx.range.timezone },
      };
    });
  }

  /**
   * Balance Sheet as at an instant, derived from posted journal lines.
   *
   * Equity includes a computed "Current Period Earnings" line
   * (SUM(REVENUE) - SUM(EXPENSE)). This is NOT an approximation - it is
   * the standard pre-closing balance-sheet derivation, and it balances
   * PROVABLY: every journal entry satisfies SUM(debit) = SUM(credit)
   * (enforced by Phase 6 at both the application and database layers), so
   * the identity Assets = Liabilities + Equity + (Revenue - Expenses)
   * holds by construction. The response asserts this with an explicit
   * `balanced` flag rather than asking the reader to trust it.
   */
  async balanceSheet(actor: RequestUser, query: BalanceSheetQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      if (!permissions) throw new ForbiddenDomainError('Insufficient permissions');

      const asAt = query.asAt ?? new Date();
      const balances = await this.accountBalances(tx, actor.tenantId, { entryDate: { lte: asAt } });

      const section = (type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE') =>
        balances.filter((b) => b.type === type);

      const totalFor = (type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE') =>
        section(type).reduce((sum, b) => sum.plus(b.normalBalance === 'DEBIT' ? b.debit.minus(b.credit) : b.credit.minus(b.debit)), new Prisma.Decimal(0));

      const assets = totalFor('ASSET');
      const liabilities = totalFor('LIABILITY');
      const postedEquity = totalFor('EQUITY');
      const revenue = totalFor('REVENUE');
      const expenses = totalFor('EXPENSE');
      const currentPeriodEarnings = revenue.minus(expenses);
      const totalEquity = postedEquity.plus(currentPeriodEarnings);

      const rows = (type: 'ASSET' | 'LIABILITY' | 'EQUITY') =>
        section(type).map((b) => ({
          accountId: b.accountId,
          code: b.code,
          name: b.name,
          balance: (b.normalBalance === 'DEBIT' ? b.debit.minus(b.credit) : b.credit.minus(b.debit)).toString(),
        }));

      return {
        data: {
          asAt: asAt.toISOString(),
          assets: { accounts: rows('ASSET'), total: assets.toString() },
          liabilities: { accounts: rows('LIABILITY'), total: liabilities.toString() },
          equity: {
            accounts: rows('EQUITY'),
            currentPeriodEarnings: currentPeriodEarnings.toString(),
            total: totalEquity.toString(),
          },
          totalLiabilitiesAndEquity: liabilities.plus(totalEquity).toString(),
          balanced: assets.equals(liabilities.plus(totalEquity)),
        },
        limitations: {
          currentPeriodEarnings:
            'Current Period Earnings is computed live as SUM(Revenue) - SUM(Expenses) from posted journal lines. No year-end closing process exists yet, so this figure is cumulative since inception rather than scoped to a fiscal year.',
          expenseScope: 'Expenses reflected here are inventory-related only - no expense-management module exists (see the P&L limitations).',
          loyaltyPoints:
            'Outstanding loyalty points are measurable through the append-only CustomerPoints ledger (the balance is SUM(points) per customer) but are NOT represented as a General Ledger liability during the controlled pilot. No accounting mapping exists for loyalty and no journal entry is posted when points are earned, so the Liabilities section above excludes the redeemable value of unredeemed points; redemption is recognised only when it happens, as a discount on the redeeming sale. Assets = Liabilities + Equity still holds exactly for what IS posted - this is an omitted obligation, not an imbalance.',
        },
      };
    });
  }

  /** Per-customer outstanding balances from the append-only customer ledger. */
  async receivables(actor: RequestUser, query: ReceivablesQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      if (!permissions) throw new ForbiddenDomainError('Insufficient permissions');

      const grouped = await tx.customerTransaction.groupBy({
        by: ['customerId'],
        where: { businessId: actor.tenantId },
        _sum: { amount: true },
      });
      const customers = await tx.customer.findMany({
        where: { id: { in: grouped.map((g) => g.customerId) }, businessId: actor.tenantId },
        select: { id: true, name: true, phone: true },
      });
      const byId = new Map(customers.map((c) => [c.id, c]));

      const rows = grouped
        .map((g) => ({
          customerId: g.customerId,
          name: byId.get(g.customerId)?.name ?? g.customerId,
          phone: byId.get(g.customerId)?.phone ?? null,
          balance: (g._sum.amount ?? new Prisma.Decimal(0)).toString(),
        }))
        .filter((r) => Number(r.balance) !== 0)
        .sort((a, b) => Number(b.balance) - Number(a.balance));

      const total = rows.reduce((s, r) => s.plus(r.balance), new Prisma.Decimal(0));
      const start = (query.page - 1) * query.limit;

      return {
        data: rows.slice(start, start + query.limit),
        summary: { totalReceivable: total.toString(), customerCount: rows.length },
        pagination: { page: query.page, limit: query.limit, total: rows.length, totalPages: Math.ceil(rows.length / query.limit) },
        limitations: { aging: 'Aging buckets are not available: no due-date or payment-terms field exists on sales or customers. Balances only.' },
      };
    });
  }

  /** Per-supplier outstanding balances from the append-only supplier ledger. */
  async payables(actor: RequestUser, query: ReceivablesQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      if (!permissions) throw new ForbiddenDomainError('Insufficient permissions');

      const grouped = await tx.supplierTransaction.groupBy({
        by: ['supplierId'],
        where: { businessId: actor.tenantId },
        _sum: { amount: true },
      });
      const suppliers = await tx.supplier.findMany({
        where: { id: { in: grouped.map((g) => g.supplierId) }, businessId: actor.tenantId },
        select: { id: true, name: true, phone: true },
      });
      const byId = new Map(suppliers.map((s) => [s.id, s]));

      const rows = grouped
        .map((g) => ({
          supplierId: g.supplierId,
          name: byId.get(g.supplierId)?.name ?? g.supplierId,
          phone: byId.get(g.supplierId)?.phone ?? null,
          balance: (g._sum.amount ?? new Prisma.Decimal(0)).toString(),
        }))
        .filter((r) => Number(r.balance) !== 0)
        .sort((a, b) => Number(b.balance) - Number(a.balance));

      const total = rows.reduce((s, r) => s.plus(r.balance), new Prisma.Decimal(0));
      const start = (query.page - 1) * query.limit;

      return {
        data: rows.slice(start, start + query.limit),
        summary: { totalPayable: total.toString(), supplierCount: rows.length },
        pagination: { page: query.page, limit: query.limit, total: rows.length, totalPages: Math.ceil(rows.length / query.limit) },
        limitations: { aging: 'Aging buckets are not available: no due-date or payment-terms field exists on purchases or suppliers. Balances only.' },
      };
    });
  }

  // ---- shared helpers -------------------------------------------------

  private async accountBalances(tx: TenantTx, businessId: string, entryFilter: Prisma.JournalEntryWhereInput) {
    const accounts = await tx.account.findMany({ where: { businessId }, orderBy: { code: 'asc' } });
    const grouped = await tx.journalEntryLine.groupBy({
      by: ['accountId'],
      where: { businessId, journalEntry: entryFilter },
      _sum: { debit: true, credit: true },
    });
    const sums = new Map(grouped.map((g) => [g.accountId, g._sum]));

    return accounts.map((a) => ({
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      normalBalance: a.normalBalance,
      debit: sums.get(a.id)?.debit ?? new Prisma.Decimal(0),
      credit: sums.get(a.id)?.credit ?? new Prisma.Decimal(0),
    }));
  }

  private async mappedAccountIds(tx: TenantTx, businessId: string): Promise<Map<AccountingMappingKey, string>> {
    const rules = await tx.accountingMappingRule.findMany({ where: { businessId }, select: { key: true, accountId: true } });
    return new Map(rules.map((r) => [r.key, r.accountId]));
  }

  private sumForAccount(
    balances: { accountId: string; debit: Prisma.Decimal; credit: Prisma.Decimal }[],
    accountId: string | undefined,
    normal: 'DEBIT' | 'CREDIT',
  ): Prisma.Decimal {
    if (!accountId) return new Prisma.Decimal(0);
    const row = balances.find((b) => b.accountId === accountId);
    if (!row) return new Prisma.Decimal(0);
    return normal === 'DEBIT' ? row.debit.minus(row.credit) : row.credit.minus(row.debit);
  }
}
