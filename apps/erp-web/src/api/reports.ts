import { api } from '../lib/apiClient';
import type {
  BalanceSheetResult,
  DashboardResult,
  DamageLossResult,
  DimensionResult,
  GeneralLedgerResult,
  MovementReportResult,
  ProfitAndLossResult,
  PurchasingSummaryResult,
  ReceivablesResult,
  ReconciliationResult,
  ReportRangeParams,
  SalesReturnsResult,
  SalesSummaryResult,
  SlowMovingResult,
  ValuationResult,
} from '../lib/apiTypes';

/**
 * Phase 19 — reporting, consumed exactly as the live backend defines it.
 *
 * NOT ONE ENDPOINT WAS ADDED. All 22 reporting routes predate this
 * milestone; the ERP reads them and renders what came back.
 *
 * ONLY PARAMETERS THAT ACTUALLY BITE ARE SENT. The reporting schemas are
 * not strict, so an unsupported key is DROPPED while the request still
 * succeeds — a control for one would silently do nothing. Verified
 * against the running server during Phase 19 discovery:
 *
 *   - `branchId` bites on the branch-scoped reports. It is ACCEPTED and
 *     IGNORED by the P&L (the General Ledger has no branch dimension),
 *     so this client does not send it there.
 *   - `warehouseId` bites on by-product and by-category only; by-branch,
 *     by-user and by-payment-method ignore it, so it is not sent to them.
 *   - Valuation, slow-moving, receivables, payables, the balance sheet
 *     and every reconciliation report take NO date range at all.
 *
 * NOTHING IS COMPUTED HERE OR ANYWHERE ELSE IN THE BROWSER. Every figure,
 * including the totals, the COGS basis and the balance-sheet equation
 * check, is the server's.
 */

function rangeQuery(params: ReportRangeParams & { page?: number; limit?: number; warehouseId?: string } = {}): string {
  const q = new URLSearchParams();
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
  if (params.branchId) q.set('branchId', params.branchId);
  if (params.warehouseId) q.set('warehouseId', params.warehouseId);
  if (params.page !== undefined) q.set('page', String(params.page));
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** The five by-dimension reports, which share one row shape and one
 *  screen. `warehouseId` is only honoured by the first two. */
export type SalesDimension = 'by-product' | 'by-category' | 'by-branch' | 'by-user' | 'by-payment-method';
export const WAREHOUSE_AWARE_DIMENSIONS: SalesDimension[] = ['by-product', 'by-category'];

export const reportsApi = {
  /**
   * `GET /reports/dashboard`, gated on `reports.dashboard.view`.
   *
   * Every figure is computed server-side from the ledger and the sale
   * records; the browser adds nothing. `branchId` is a FILTER the server
   * then validates against the caller's own branch scope — passing one the
   * caller is not entitled to is a 403, never a silent empty result.
   */
  dashboard: (params: ReportRangeParams = {}) => api.get<DashboardResult>(`/reports/dashboard${rangeQuery(params)}`),

  // --------------------------------------------------------- sales -----
  /** `reports.sales.view`. */
  salesSummary: (params: ReportRangeParams = {}) => api.get<SalesSummaryResult>(`/reports/sales/summary${rangeQuery(params)}`),

  /** `reports.sales.view`. One call per dimension; the row shape is
   *  identical, which is why one table renders all five. */
  salesByDimension: (dimension: SalesDimension, params: ReportRangeParams & { page?: number; warehouseId?: string } = {}) =>
    api.get<DimensionResult>(
      `/reports/sales/${dimension}${rangeQuery({
        ...params,
        // Not sent where the server ignores it: an inert filter is worse
        // than an absent one.
        warehouseId: WAREHOUSE_AWARE_DIMENSIONS.includes(dimension) ? params.warehouseId : undefined,
        limit: 50,
      })}`,
    ),

  /** `reports.sales.view`. */
  salesReturns: (params: ReportRangeParams & { page?: number } = {}) =>
    api.get<SalesReturnsResult>(`/reports/sales/returns${rangeQuery({ ...params, limit: 20 })}`),

  /** `reports.sales.view` — purchasing's summary lives under the SALES
   *  grant in the live contract, not under `purchases.view`. */
  purchasingSummary: (params: ReportRangeParams = {}) =>
    api.get<PurchasingSummaryResult>(`/reports/purchasing/summary${rangeQuery(params)}`),

  // ----------------------------------------------------- inventory -----
  /** `reports.inventory.view`. NO date range in the contract — a
   *  valuation is an as-at-now position. */
  valuation: (params: { warehouseId?: string; branchId?: string; page?: number } = {}) =>
    api.get<ValuationResult>(`/reports/inventory/valuation${rangeQuery({ ...params, limit: 50 })}`),

  /** `reports.inventory.view`. */
  movements: (params: ReportRangeParams & { warehouseId?: string; variantId?: string; movementType?: string; page?: number } = {}) => {
    const q = new URLSearchParams(rangeQuery({ ...params, limit: 50 }).replace(/^\?/, ''));
    if (params.variantId) q.set('variantId', params.variantId);
    if (params.movementType) q.set('movementType', params.movementType);
    return api.get<MovementReportResult>(`/reports/inventory/movements?${q.toString()}`);
  },

  /** `reports.inventory.view`. */
  damageLoss: (params: ReportRangeParams & { warehouseId?: string; page?: number } = {}) =>
    api.get<DamageLossResult>(`/reports/inventory/damage-loss${rangeQuery({ ...params, limit: 50 })}`),

  /** `reports.inventory.view`. `days` (not a date range) defines "slow". */
  slowMoving: (params: { warehouseId?: string; branchId?: string; days?: number; page?: number } = {}) => {
    const q = new URLSearchParams(rangeQuery({ ...params, limit: 50 }).replace(/^\?/, ''));
    if (params.days !== undefined) q.set('days', String(params.days));
    return api.get<SlowMovingResult>(`/reports/inventory/slow-moving?${q.toString()}`);
  },

  // ----------------------------------------------------- financial -----
  /** `reports.financial.view`. */
  generalLedger: (params: ReportRangeParams & { accountId?: string; page?: number } = {}) => {
    const q = new URLSearchParams(rangeQuery({ ...params, limit: 50 }).replace(/^\?/, ''));
    if (params.accountId) q.set('accountId', params.accountId);
    return api.get<GeneralLedgerResult>(`/reports/financial/general-ledger?${q.toString()}`);
  },

  /**
   * `reports.financial.view`. Carries `costOfGoodsSold`, `grossProfit`
   * and `netProfit` unconditionally for any holder of that grant — the
   * Phase 19 owner decision, which this client relies on rather than
   * treating those keys as optional.
   *
   * `branchId` is deliberately NOT sent: the schema accepts it and the
   * use-case ignores it, because the General Ledger this report is
   * derived from has no branch dimension.
   */
  profitAndLoss: (params: { from?: string; to?: string } = {}) =>
    api.get<ProfitAndLossResult>(`/reports/financial/profit-and-loss${rangeQuery({ from: params.from, to: params.to })}`),

  /** `reports.financial.view`. An "as at" instant, not a range. */
  balanceSheet: (params: { asAt?: string } = {}) =>
    api.get<BalanceSheetResult>(`/reports/financial/balance-sheet${params.asAt ? `?asAt=${encodeURIComponent(params.asAt)}` : ''}`),

  /** `reports.financial.view`. Page and limit only — no range, no branch. */
  receivables: (params: { page?: number } = {}) =>
    api.get<ReceivablesResult>(`/reports/financial/receivables${rangeQuery({ page: params.page, limit: 50 })}`),

  /** `reports.financial.view`. */
  payables: (params: { page?: number } = {}) =>
    api.get<ReceivablesResult>(`/reports/financial/payables${rangeQuery({ page: params.page, limit: 50 })}`),

  // ------------------------------------------------ reconciliation -----
  /** `reports.inventory.view` — the ONLY reconciliation report under the
   *  inventory grant; the other three are financial. */
  reconInventoryLedger: (params: { page?: number } = {}) =>
    api.get<ReconciliationResult>(`/reports/reconciliation/inventory-ledger${rangeQuery({ page: params.page, limit: 50 })}`),

  /** `reports.financial.view`. */
  reconCustomerAr: (params: { page?: number } = {}) =>
    api.get<ReconciliationResult>(`/reports/reconciliation/customer-ar${rangeQuery({ page: params.page, limit: 50 })}`),

  /** `reports.financial.view`. */
  reconSupplierAp: (params: { page?: number } = {}) =>
    api.get<ReconciliationResult>(`/reports/reconciliation/supplier-ap${rangeQuery({ page: params.page, limit: 50 })}`),

  /** `reports.financial.view`. */
  reconInventoryGl: (params: { page?: number } = {}) =>
    api.get<ReconciliationResult>(`/reports/reconciliation/inventory-gl${rangeQuery({ page: params.page, limit: 50 })}`),
};
