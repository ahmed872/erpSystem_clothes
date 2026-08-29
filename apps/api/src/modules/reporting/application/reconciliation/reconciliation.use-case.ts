import { Injectable } from '@nestjs/common';
import { AccountingMappingKey, Prisma } from '@prisma/client';
import type { ReconciliationQuery } from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { ForbiddenDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Reconciliation reports verify invariants that ALREADY hold by
 * construction elsewhere in the system - their job is to prove it on
 * live data, and to surface any discrepancy in full rather than
 * summarising it away.
 *
 * Error threshold is EXACT EQUALITY (zero tolerance) for the ledger
 * reconciliations: all of them compare Decimal sums of the same
 * underlying events, so any non-zero delta is a real problem, never
 * floating-point noise.
 *
 * NOT IMPLEMENTED - Cash Register vs Cash Transactions: neither
 * CashRegister nor CashTransaction exists in the schema (Phase 6 scope
 * decision), so there is nothing to reconcile. NOT IN PHASE.
 */
@Injectable()
export class ReconciliationUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  /** #1 Stock Ledger vs the derived StockBalance cache. */
  async inventoryLedger(actor: RequestUser, query: ReconciliationQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      await this.requirePermissions(tx, actor);

      const movements = await tx.stockMovement.groupBy({
        by: ['warehouseId', 'variantId'],
        where: { businessId: actor.tenantId },
        _sum: { quantityBase: true },
      });
      const balances = await tx.stockBalance.findMany({
        where: { businessId: actor.tenantId },
        select: { warehouseId: true, variantId: true, quantityOnHand: true },
      });
      const balanceByKey = new Map(balances.map((b) => [`${b.warehouseId}:${b.variantId}`, b.quantityOnHand]));

      const discrepancies: { warehouseId: string; variantId: string; ledgerQuantity: string; balanceQuantity: string; delta: string }[] = [];
      for (const m of movements) {
        const key = `${m.warehouseId}:${m.variantId}`;
        const ledger = m._sum.quantityBase ?? new Prisma.Decimal(0);
        const balance = balanceByKey.get(key) ?? new Prisma.Decimal(0);
        if (!ledger.equals(balance)) {
          discrepancies.push({
            warehouseId: m.warehouseId,
            variantId: m.variantId,
            ledgerQuantity: ledger.toString(),
            balanceQuantity: balance.toString(),
            delta: ledger.minus(balance).toString(),
          });
        }
      }

      return this.paginate(
        {
          sourceA: 'stock_movements: SUM(quantity_base) per (warehouse, variant)',
          sourceB: 'stock_balances: quantity_on_hand',
          expectedRelationship: 'Exactly equal - zero tolerance.',
          exclusions: [],
          reconciled: discrepancies.length === 0,
          discrepancyCount: discrepancies.length,
        },
        discrepancies,
        query,
      );
    });
  }

  /** #2 Customer subledger vs the Accounts Receivable control account. */
  async customerAr(actor: RequestUser, query: ReconciliationQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      await this.requirePermissions(tx, actor);

      const subledgerAgg = await tx.customerTransaction.aggregate({ where: { businessId: actor.tenantId }, _sum: { amount: true } });
      const subledger = subledgerAgg._sum.amount ?? new Prisma.Decimal(0);
      const control = await this.controlAccountBalance(tx, actor.tenantId, 'ACCOUNTS_RECEIVABLE', 'DEBIT');
      const delta = subledger.minus(control);

      const perCustomer =
        delta.equals(0)
          ? []
          : (
              await tx.customerTransaction.groupBy({ by: ['customerId'], where: { businessId: actor.tenantId }, _sum: { amount: true } })
            ).map((g) => ({ customerId: g.customerId, balance: (g._sum.amount ?? new Prisma.Decimal(0)).toString() }));

      return this.paginate(
        {
          sourceA: 'customer_transactions: SUM(amount) across all customers',
          sourceB: 'General Ledger: Accounts Receivable control account balance',
          expectedRelationship: 'Exactly equal - zero tolerance.',
          exclusions: [],
          subledgerTotal: subledger.toString(),
          controlAccountBalance: control.toString(),
          delta: delta.toString(),
          reconciled: delta.equals(0),
        },
        perCustomer,
        query,
      );
    });
  }

  /** #3 Supplier subledger vs the Accounts Payable control account. */
  async supplierAp(actor: RequestUser, query: ReconciliationQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      await this.requirePermissions(tx, actor);

      const subledgerAgg = await tx.supplierTransaction.aggregate({ where: { businessId: actor.tenantId }, _sum: { amount: true } });
      const subledger = subledgerAgg._sum.amount ?? new Prisma.Decimal(0);
      const control = await this.controlAccountBalance(tx, actor.tenantId, 'ACCOUNTS_PAYABLE', 'CREDIT');
      const delta = subledger.minus(control);

      const perSupplier =
        delta.equals(0)
          ? []
          : (
              await tx.supplierTransaction.groupBy({ by: ['supplierId'], where: { businessId: actor.tenantId }, _sum: { amount: true } })
            ).map((g) => ({ supplierId: g.supplierId, balance: (g._sum.amount ?? new Prisma.Decimal(0)).toString() }));

      return this.paginate(
        {
          sourceA: 'supplier_transactions: SUM(amount) across all suppliers',
          sourceB: 'General Ledger: Accounts Payable control account balance',
          expectedRelationship: 'Exactly equal - zero tolerance.',
          exclusions: [],
          subledgerTotal: subledger.toString(),
          controlAccountBalance: control.toString(),
          delta: delta.toString(),
          reconciled: delta.equals(0),
        },
        perSupplier,
        query,
      );
    });
  }

  /**
   * #4 Inventory ledger VALUE vs the General Ledger Inventory account.
   *
   * MANDATORY EXCLUSIONS - inventory movements that change stock value but
   * deliberately produce NO journal entry. Each is excluded from the
   * comparison AND reported as its own explicit, quantified line, so the
   * causes of any divergence can never be confused with one another or
   * with a genuine accounting error.
   *
   * IMPORTANT CORRECTION discovered during Phase 7 implementation, by
   * inspecting the actual code rather than trusting the issue text: the
   * stock-count gap is NOT identifiable by `movementType = 'STOCK_COUNT'`.
   * That enum value is DEAD - grep confirms no code path in the system
   * ever writes it. `ApproveStockCountUseCase` actually writes movements
   * with `movementType = 'ADJUSTMENT'` and `referenceType = 'StockCount'`,
   * and does not post to the General Ledger. Excluding by movement type
   * would therefore have excluded nothing at all while appearing to work,
   * and would simultaneously have been unable to distinguish a
   * stock-count ADJUSTMENT (no GL entry) from an AdjustStockUseCase
   * ADJUSTMENT (which DOES post). `referenceType` is the only reliable
   * discriminator. See PROJECT_STATE.md Known Issue #37 (restated).
   *
   * The two exclusions:
   *   1. referenceType 'StockCount' - stock-count approval adjustments.
   *   2. OPENING_BALANCE - opening stock is deliberately never posted
   *      (an explicit Phase 6 scope decision, see seedAccountingDefaults:
   *      Opening Balance Equity is seeded but carries no mapping key).
   *
   * TRANSFER_IN/TRANSFER_OUT are NOT excluded: they are equal-and-opposite
   * at carried-over cost, so they sum to zero value and correctly have no
   * GL effect under the business-scoped Chart of Accounts.
   */
  async inventoryGl(actor: RequestUser, query: ReconciliationQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      await this.requirePermissions(tx, actor);

      const all = await tx.stockMovement.findMany({
        where: { businessId: actor.tenantId },
        select: { movementType: true, referenceType: true, quantityBase: true, unitCostAtMovement: true },
      });

      let postedLedgerValue = new Prisma.Decimal(0);
      let stockCountValue = new Prisma.Decimal(0);
      let stockCountCount = 0;
      let openingBalanceValue = new Prisma.Decimal(0);
      let openingBalanceCount = 0;

      for (const m of all) {
        const value = m.quantityBase.times(m.unitCostAtMovement);
        if (m.referenceType === 'StockCount') {
          stockCountValue = stockCountValue.plus(value);
          stockCountCount += 1;
        } else if (m.movementType === 'OPENING_BALANCE') {
          openingBalanceValue = openingBalanceValue.plus(value);
          openingBalanceCount += 1;
        } else {
          postedLedgerValue = postedLedgerValue.plus(value);
        }
      }

      const control = await this.controlAccountBalance(tx, actor.tenantId, 'INVENTORY_ASSET', 'DEBIT');
      const delta = postedLedgerValue.minus(control);

      return {
        summary: {
          sourceA: 'stock_movements: SUM(quantity_base x unit_cost_at_movement), EXCLUDING the non-posting movements listed below',
          sourceB: 'General Ledger: Inventory asset account balance',
          expectedRelationship: 'Equal after the documented exclusions below. Zero tolerance on the remaining delta.',
          exclusions: [
            {
              excludedBy: "referenceType = 'StockCount'",
              movementType: 'ADJUSTMENT (written by stock-count approval)',
              reason:
                'Stock-count approval adjustments produce no General Ledger entry (documented limitation #37). NOTE: these are written with movementType ADJUSTMENT and referenceType StockCount - the STOCK_COUNT movement type is never written by any code path, so referenceType is the only reliable discriminator. This divergence is EXPECTED and is NOT an accounting error.',
              excludedValue: stockCountValue.toString(),
              excludedMovementCount: stockCountCount,
            },
            {
              excludedBy: "movementType = 'OPENING_BALANCE'",
              movementType: 'OPENING_BALANCE',
              reason:
                'Opening stock is deliberately never posted to the General Ledger (explicit Phase 6 scope decision - Opening Balance Equity is seeded in the Chart of Accounts but carries no mapping key). This divergence is EXPECTED and is NOT an accounting error.',
              excludedValue: openingBalanceValue.toString(),
              excludedMovementCount: openingBalanceCount,
            },
          ],
          inventoryLedgerValueExcludingNonPosting: postedLedgerValue.toString(),
          controlAccountBalance: control.toString(),
          delta: delta.toString(),
          reconciled: delta.equals(0),
          note: delta.equals(0)
            ? 'Reconciled. The excluded values shown above are expected, documented limitations, not discrepancies.'
            : 'NOT reconciled after the documented exclusions. This delta is a genuine discrepancy requiring investigation - it is NOT explained by the stock-count or opening-balance limitations.',
        },
        data: [],
        pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
      };
    });
  }

  // ---- helpers --------------------------------------------------------

  private async requirePermissions(tx: TenantTx, actor: RequestUser) {
    const permissions = await this.effectivePermissions.get(tx, actor.id);
    if (!permissions) throw new ForbiddenDomainError('Insufficient permissions');
    return permissions;
  }

  private async controlAccountBalance(tx: TenantTx, businessId: string, key: AccountingMappingKey, normal: 'DEBIT' | 'CREDIT'): Promise<Prisma.Decimal> {
    const rule = await tx.accountingMappingRule.findFirst({ where: { businessId, key }, select: { accountId: true } });
    if (!rule) return new Prisma.Decimal(0);
    const agg = await tx.journalEntryLine.aggregate({ where: { businessId, accountId: rule.accountId }, _sum: { debit: true, credit: true } });
    const debit = agg._sum.debit ?? new Prisma.Decimal(0);
    const credit = agg._sum.credit ?? new Prisma.Decimal(0);
    return normal === 'DEBIT' ? debit.minus(credit) : credit.minus(debit);
  }

  private paginate<T>(summary: Record<string, unknown>, rows: T[], query: ReconciliationQuery) {
    const start = (query.page - 1) * query.limit;
    return {
      summary,
      data: rows.slice(start, start + query.limit),
      pagination: { page: query.page, limit: query.limit, total: rows.length, totalPages: Math.ceil(rows.length / query.limit) },
    };
  }
}
