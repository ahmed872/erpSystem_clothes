import type { SalesDimension } from '../api/reports';
import type {
  BalanceSheetResult,
  DamageLossRow,
  DimensionRow,
  GeneralLedgerRow,
  MovementReportRow,
  PartyBalanceRow,
  ReconciliationResult,
  SalesReturnReportRow,
  SalesSummary,
  SlowMovingRow,
  ValuationRow,
} from './apiTypes';

/**
 * Phase 19 — the only reporting logic in the ERP browser, and it computes
 * no figure of any kind.
 *
 * THERE IS NO TOTAL, SUBTOTAL, COGS, MARGIN, PROFIT, VALUATION, BALANCE
 * OR VARIANCE ARITHMETIC HERE AND THERE MUST NEVER BE ANY. Every number a
 * report screen prints was aggregated by the server inside one
 * transaction, over ledgers the browser never holds in full, on a
 * historical cost basis (`unitCostAtMovement`) it cannot reconstruct. A
 * browser that added a page of rows together would produce a figure that
 * looks authoritative, disagrees with the server's, and is wrong the
 * moment there is a second page.
 *
 * Even the balance sheet's own equation check is the SERVER's `balanced`
 * flag rather than a comparison made here.
 */

/**
 * THE DATE CONTRACT, STATED ONCE.
 *
 * The server resolves `from`/`to` in the BUSINESS's own timezone into a
 * half-open `[from, toExclusive)` interval, defaults to the current
 * calendar month, and echoes the window it actually used. So the screens
 * send two calendar dates and print the server's echo — they never
 * compute a boundary, never assume UTC, and never render `range.to` as an
 * inclusive end date.
 */
export const RANGE_IS_HALF_OPEN = true;

/**
 * Reports that accept NO date range in the live contract, so no
 * date control is shown on them. Written down because an inert control
 * is worse than an absent one: the schemas are not strict, so `from`/`to`
 * sent here would be dropped while the request still succeeded.
 */
export const RANGELESS_REPORTS = [
  'inventory/valuation',
  'inventory/slow-moving',
  'financial/balance-sheet',
  'financial/receivables',
  'financial/payables',
  'reconciliation',
] as const;

/**
 * `warehouseId` is honoured by by-product and by-category and IGNORED by
 * the other three by-dimension reports. Verified against the running
 * server; the screen hides the control rather than offering an inert one.
 */
export function dimensionSupportsWarehouse(dimension: SalesDimension): boolean {
  return dimension === 'by-product' || dimension === 'by-category';
}

/**
 * The P&L accepts `branchId` and ignores it: it is derived from the
 * General Ledger, which has no branch dimension. Recorded so no screen
 * grows a branch picker that silently changes nothing.
 */
export const PROFIT_AND_LOSS_IS_BUSINESS_WIDE = true;

/**
 * PHASE 19 OWNER DECISION, recorded where the screens can point at it.
 *
 * `reports.financial.view` IMPLIES visibility of the financial reports'
 * own contents, profit lines included: a Profit & Loss without
 * `grossProfit` is a document with its purpose removed, and the General
 * Ledger under the same grant exposes the COGS journal lines from which
 * profit is trivially derivable anyway. So `reports.view_profit` is NOT
 * an additional gate inside the financial family, and these screens
 * render the server's figures without checking any permission.
 *
 * This does NOT relax the rule everywhere else: on the sales, purchasing,
 * inventory and dashboard reports the server still deletes cost and
 * profit keys for a caller lacking the grants, and those screens ask
 * whether the response CARRIED a field — never whether a grant is held.
 */
export const FINANCIAL_VIEW_IMPLIES_PROFIT = true;

/** Whether the caller was sent the COGS figure at all. */
export function hasCogs(row: Pick<SalesSummary, 'cogs'>): boolean {
  return row.cogs !== undefined;
}

/** Whether the caller was sent the gross-profit figure at all. */
export function hasGrossProfit(row: Pick<SalesSummary, 'grossProfit'>): boolean {
  return row.grossProfit !== undefined;
}

/**
 * Whether ANY row on this page carried cost/profit — the question a table
 * asks before deciding to render those columns at all. Asked of the
 * PAYLOAD, never of a permission: no client-side branch can then be
 * flipped to reveal a figure the response never contained.
 */
export function rowsCarryCost(rows: { averageCost?: string; inventoryValue?: string; unitCostAtMovement?: string; movementValue?: string; cogs?: string }[]): boolean {
  return rows.some(
    (r) =>
      r.averageCost !== undefined ||
      r.inventoryValue !== undefined ||
      r.unitCostAtMovement !== undefined ||
      r.movementValue !== undefined ||
      r.cogs !== undefined,
  );
}

export function rowsCarryProfit(rows: Pick<DimensionRow, 'grossProfit'>[]): boolean {
  return rows.some((r) => r.grossProfit !== undefined);
}

/**
 * `by-user` returns `quantity`, `cogs` and `grossProfit` as the literal
 * string `'0'` — the server groups Sale rows, which carry no per-line
 * quantity or cost. Those are AUTHORITATIVE placeholder values, not
 * missing data, so the screen says so instead of printing three zeros a
 * reader would take as fact.
 */
export function dimensionHasOnlyRevenue(dimension: SalesDimension): boolean {
  return dimension === 'by-user' || dimension === 'by-payment-method';
}

/** Tone for a stock movement in the reports, from the SIGN the ledger
 *  stored rather than from the movement type. */
export function movementTone(row: Pick<MovementReportRow, 'quantityBase' | 'isNegativeStock'>): 'success' | 'warning' | 'danger' {
  if (row.isNegativeStock) return 'danger';
  return Number(row.quantityBase) >= 0 ? 'success' : 'warning';
}

export function damageTone(row: Pick<DamageLossRow, 'movementType'>): 'danger' | 'warning' | 'neutral' {
  if (row.movementType === 'DAMAGE' || row.movementType === 'LOSS') return 'danger';
  if (row.movementType === 'EXPIRY') return 'warning';
  return 'neutral';
}

/** A ledger line is one side or the other; a COMPARISON of the server's
 *  two stored figures, never a subtraction. */
export function ledgerSide(row: Pick<GeneralLedgerRow, 'debit' | 'credit'>): 'debit' | 'credit' | 'none' {
  if (Number(row.debit) > 0) return 'debit';
  if (Number(row.credit) > 0) return 'credit';
  return 'none';
}

/** A party still owing something. Comparison only. */
export function hasOutstanding(row: Pick<PartyBalanceRow, 'balance'>): boolean {
  const n = Number(row.balance);
  return Number.isFinite(n) && n !== 0;
}

/** A variant that has never sold at all, which reads differently from one
 *  that merely has not sold lately. */
export function neverSold(row: Pick<SlowMovingRow, 'lastSaleAt'>): boolean {
  return row.lastSaleAt === null;
}

/** Whether a valuation row carried its money columns. */
export function valuationHasValue(row: Pick<ValuationRow, 'inventoryValue'>): boolean {
  return row.inventoryValue !== undefined;
}

/** A walk-in return has no customer account behind it, which is why the
 *  returns report separates the two totals. */
export function isWalkInReturn(row: Pick<SalesReturnReportRow, 'isWalkIn'>): boolean {
  return row.isWalkIn;
}

/**
 * Whether a reconciliation came out clean. Read from the SERVER's own
 * `reconciled` flag and `discrepancyCount` — never by comparing the two
 * sources here, which would be a second reconciliation engine free to
 * disagree with the one that matters.
 */
export function isReconciled(result: Pick<ReconciliationResult, 'summary'>): boolean | null {
  const { reconciled, discrepancyCount } = result.summary;
  if (typeof reconciled === 'boolean') return reconciled;
  if (typeof discrepancyCount === 'number') return discrepancyCount === 0;
  return null;
}

/** The balance sheet's own equation check, as the server reported it. */
export function isBalanced(result: Pick<BalanceSheetResult, 'data'>): boolean {
  return result.data.balanced;
}

/** The server's written caveats, in a stable order for rendering. */
export function limitationEntries(limitations: Record<string, string> | undefined): [string, string][] {
  return Object.entries(limitations ?? {});
}
