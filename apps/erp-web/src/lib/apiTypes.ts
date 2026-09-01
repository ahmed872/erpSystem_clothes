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

// ------------------------------------------------------- Catalogue -------
/**
 * Phase 14. Traced to the live `catalog` module — `PRODUCT_INCLUDE` /
 * `VARIANT_INCLUDE` in `domain/includes.ts` and the zod schemas in
 * `packages/shared-validation/src/catalog.ts`.
 *
 * COST IS OPTIONAL EVERYWHERE IT APPEARS, and that is the whole cost
 * model on these screens: the server DELETES `defaultCost` and `cost` for
 * a caller without `products.view_cost` — on write responses as well as
 * read ones, as of this milestone. The browser therefore renders what
 * arrived and never decides the permission itself.
 */

export type ProductStatus = 'ACTIVE' | 'INACTIVE' | 'DISCONTINUED';
export type ProductType = 'SIMPLE' | 'BUNDLE';
export type VariantStatus = 'ACTIVE' | 'INACTIVE';

export interface Uom {
  id: string;
  name: string;
  code: string;
  precision: number;
  isActive: boolean;
}

export interface Category {
  id: string;
  name: string;
  parentId: string | null;
  description: string | null;
  isActive: boolean;
}

export interface Brand {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface AttributeValue {
  id: string;
  attributeId: string;
  value: string;
  sortOrder: number;
}

export interface Attribute {
  id: string;
  name: string;
  isActive: boolean;
  values: AttributeValue[];
}

export interface Tax {
  id: string;
  name: string;
  ratePercent: string;
  isActive: boolean;
}

export interface Barcode {
  id: string;
  variantId: string;
  code: string;
  isPrimary: boolean;
}

/** A variant as the catalogue detail screen receives it. */
export interface Variant {
  id: string;
  productId: string;
  sku: string;
  status: VariantStatus;
  sellingPrice: string;
  /** Gated by `products.view_cost` — absent, not null, when not held. */
  cost?: string;
  weight: string | null;
  barcodes: Barcode[];
  attributeValues: { attributeValue: AttributeValue & { attribute: { id: string; name: string } } }[];
}

/** The lean row shape `GET /catalog/products` puts in its list. */
export interface ProductListRow {
  id: string;
  sku: string;
  name: string;
  alternativeName: string | null;
  type: ProductType;
  status: ProductStatus;
  defaultSellingPrice: string;
  /** Gated by `products.view_cost`. */
  defaultCost?: string;
  categoryId: string | null;
  brandId: string | null;
  category: Category | null;
  brand: Brand | null;
  baseUom: Uom;
  variants: { id: string; sku: string; status: VariantStatus }[];
}

export interface BundleItem {
  bundleProductId: string;
  componentVariantId: string;
  quantity: string;
  componentVariant: Variant & { product: { id: string; name: string; sku: string } };
}

/** The full record `GET /catalog/products/:id` returns. */
export interface ProductDetail extends Omit<ProductListRow, 'variants'> {
  description: string | null;
  taxId: string | null;
  taxExempt: boolean;
  minimumStock: string | null;
  maximumStock: string | null;
  tracksLots: boolean;
  tracksSerialNumbers: boolean;
  baseUomId: string;
  variants: Variant[];
  bundleItems: BundleItem[];
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ProductListResult {
  data: ProductListRow[];
  pagination: Pagination;
}

export interface ProductListFilters {
  search?: string;
  categoryId?: string;
  brandId?: string;
  status?: ProductStatus;
  type?: ProductType;
  page?: number;
  limit?: number;
}

// --------------------------------------------------------- Pricing -------
/**
 * `PriceList` carries exactly two applicability signals — `isDefault` and
 * `isActive` — and nothing else. There is no customer-, branch- or
 * warehouse-scoped price list in the live schema, and this app does not
 * invent one: see `lib/priceLists.ts`.
 */
export interface PriceList {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface PriceListEntry {
  id: string;
  priceListId: string;
  variantId: string;
  price: string;
  variant: { id: string; sku: string; product: { id: string; name: string } };
}
