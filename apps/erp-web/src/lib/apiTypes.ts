/**
 * Phase 13 (ERP Web) — types traced to the LIVE backend contracts, exactly
 * as `apps/pos-web/src/lib/apiTypes.ts` is.
 *
 * Deliberately narrow: this milestone consumes three endpoints, so it
 * declares three response shapes and nothing speculative. Money is a
 * decimal-as-string over the wire (`Decimal#toJSON`), so every money field
 * is `string` and must be parsed before display — never before arithmetic,
 * because this app performs none.
 *
 * Fields the server REMOVES (rather than nulls) for a caller lacking the
 * permission that gates them are typed optional (`?`). That is the same
 * convention the POS uses for cost and expected cash, and it is what lets
 * a screen render "what arrived" instead of re-deciding a permission.
 */

export type PermissionCode = string;

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; name: string; email: string };
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface MyPermissionsResult {
  permissions: PermissionCode[];
}

// ----------------------------------------------------------- Dashboard ----

/**
 * `GET /reports/dashboard`.
 *
 * EVERY COST FIELD AND EVERY PROFIT FIELD IS OPTIONAL, and that is the
 * whole permission model on this screen: the server DELETES `totalCost`,
 * `cogs` and `inventoryValue` for a caller without `products.view_cost`,
 * and `grossProfit`/`netProfit` for one without `reports.view_profit`
 * (`report-visibility.ts`). A BRANCH_MANAGER holds neither, so their
 * response genuinely has no such keys — the browser never hides a number
 * it received.
 */
export interface DashboardKpis {
  sales: string;
  netSales: string;
  discounts: string;
  transactions: number;
  averageInvoice: string;
  receivables: string;
  payables: string;
  cashBalance: string;
  bankBalance: string;
  inventoryRelatedOperatingExpenses: string;
  /** Gated by `products.view_cost` — absent, not null, when not held. */
  totalCost?: string;
  cogs?: string;
  inventoryValue?: string;
  /** Gated by `reports.view_profit` — absent, not null, when not held. */
  grossProfit?: string;
  netProfit?: string;
}

export interface DashboardProductRow {
  variantId: string;
  sku: string;
  name: string;
  quantity: string;
  revenue: string;
  profit?: string;
  marginPercent?: string;
}

export interface DashboardResult {
  data: {
    kpis: DashboardKpis;
    topProducts: DashboardProductRow[];
    slowestProducts: DashboardProductRow[];
  };
  /** The server's own written statement of what these figures do NOT
   *  include. Displayed verbatim rather than paraphrased. */
  limitations: Record<string, string>;
  range: { from: string; to: string; timezone: string };
}

// ------------------------------------------------------------ Warranty ----

export type WarrantyStatus = 'ACTIVE' | 'EXPIRED' | 'CLAIMED' | 'VOID';
export type WarrantyClaimStatus = 'OPEN' | 'RESOLVED' | 'REJECTED';

export interface WarrantyClaim {
  id: string;
  warrantyId: string;
  claimedAt: string;
  description: string;
  status: WarrantyClaimStatus;
  resolution: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
}

export interface WarrantyListRow {
  id: string;
  saleItemId: string;
  serialNumberId: string;
  customerId: string | null;
  startDate: string;
  endDate: string;
  durationDays: number;
  status: WarrantyStatus;
  /** Date-aware, derived by the server on read. Display THIS, never
   *  `status`, and never a comparison made in the browser. */
  effectiveStatus: WarrantyStatus;
  notes: string | null;
  createdAt: string;
  serialNumber: { id: string; serial: string };
  customer: { id: string; name: string } | null;
  saleItem: { id: string; variantId: string; sale: { id: string; saleNumber: string } };
  claimCount: number;
}

export interface WarrantyDetail extends Omit<WarrantyListRow, 'claimCount' | 'saleItem' | 'customer'> {
  customer: { id: string; name: string; phone: string | null } | null;
  saleItem: {
    id: string;
    variantId: string;
    quantity: string;
    sale: { id: string; saleNumber: string; createdAt: string; branchId: string };
  };
  claims: WarrantyClaim[];
}

/** The ONLY two outcomes the backend accepts (`resolveWarrantyClaimSchema`).
 *  There is deliberately no path back to OPEN and no third status. */
export type ClaimResolution = 'RESOLVED' | 'REJECTED';

// -------------------------------------------------------------- Shifts ----

export type ShiftStatus = 'OPEN' | 'CLOSED';

export interface Shift {
  id: string;
  businessId: string;
  branchId: string;
  warehouseId: string;
  cashRegisterId: string;
  openedBy: string;
  openedAt: string;
  openingFloat: string;
  closedBy: string | null;
  closedAt: string | null;
  countedCash: string | null;
  reconciledBy: string | null;
  reconciledAt: string | null;
  reconciliationNote: string | null;
  status: ShiftStatus;
  /**
   * Present ONLY for a caller holding `shifts.view_expected` — the blind
   * close rule (BD-17 rule 4). The server removes these four keys rather
   * than nulling them, so a till user's response never carries the figure
   * at all.
   */
  cashIn?: string;
  cashOut?: string;
  expectedCash?: string;
  variance?: string | null;
}

export interface CashRegister {
  id: string;
  businessId: string;
  branchId: string;
  name: string;
  code: string;
  isActive: boolean;
}
