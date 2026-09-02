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

// ------------------------------------------------------- Inventory -------
/**
 * Phase 15. Traced to the live `inventory` module — its controllers, the
 * zod schemas in `packages/shared-validation/src/inventory.ts`, and the
 * Prisma models.
 *
 * COST IS OPTIONAL WHEREVER IT APPEARS, on reads AND on mutation results.
 * `StockBalance.averageCost`, `StockMovement.unitCostAtMovement` and the
 * engine's post-mutation `averageCost`/`cogsPerUnit` are all deleted for a
 * caller without `products.view_cost` — the write paths as of this
 * milestone, the read paths already. A BRANCH_MANAGER holds
 * `inventory.view` and NOT `products.view_cost`, and genuinely receives
 * no such key.
 *
 * NOTE WHAT IS ABSENT FROM THE MODEL. `InventoryLot` carries no quantity
 * and no cost — it is a registry of lot METADATA, not a counter — and
 * `SerialNumber` carries no cost either. Neither is an omission this app
 * should paper over.
 */

export interface Warehouse {
  id: string;
  businessId: string;
  branchId: string;
  name: string;
  code: string;
  isActive: boolean;
}

export interface StockBalance {
  id: string;
  warehouseId: string;
  variantId: string;
  quantityOnHand: string;
  /**
   * DISPLAY ONLY. Nothing in the live backend writes this column: the
   * held-sale advisory reservation is a deferred decision and there are no
   * reservation endpoints. It exists so staff can see how much of the
   * shelf is already spoken for.
   */
  quantityReserved: string;
  /** Server-computed: quantityOnHand - quantityReserved. Never derived here. */
  availableQuantity: string;
  /** Gated by `products.view_cost` — absent, not null, when not held. */
  averageCost?: string;
  updatedAt: string;
  variant: { id: string; sku: string; product: { id: string; name: string } };
  warehouse: { id: string; name: string };
}

export type StockMovementType =
  | 'OPENING_BALANCE'
  | 'PURCHASE'
  | 'SALE'
  | 'SALES_RETURN'
  | 'PURCHASE_RETURN'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'STOCK_COUNT'
  | 'ADJUSTMENT'
  | 'DAMAGE'
  | 'LOSS'
  | 'INTERNAL_CONSUMPTION'
  | 'EXPIRY'
  | 'BUNDLE_CONSUMPTION'
  | 'AUTHORIZED_CORRECTION';

/** The signed adjustment reasons `adjustStockSchema` accepts — a strict
 *  subset of the movement types above. */
export type AdjustmentType = 'ADJUSTMENT' | 'DAMAGE' | 'LOSS' | 'INTERNAL_CONSUMPTION' | 'EXPIRY';

export interface StockMovement {
  id: string;
  warehouseId: string;
  variantId: string;
  movementType: StockMovementType;
  /** Signed base-unit quantity. Negative means stock left. */
  quantityBase: string;
  quantityInUom: string | null;
  /** Gated by `products.view_cost`. */
  unitCostAtMovement?: string;
  referenceType: string | null;
  referenceId: string | null;
  lotId: string | null;
  isNegativeStock: boolean;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
  variant: { id: string; sku: string };
  warehouse: { id: string; name: string };
}

export interface MovementListResult {
  data: StockMovement[];
  pagination: Pagination;
}

export interface MovementFilters {
  warehouseId?: string;
  variantId?: string;
  movementType?: StockMovementType;
  page?: number;
  limit?: number;
}

/** Metadata registry, NOT a quantity counter — the model has no quantity. */
export interface InventoryLot {
  id: string;
  variantId: string;
  lotNumber: string;
  manufacturingDate: string | null;
  expiryDate: string | null;
  createdAt: string;
}

export type SerialStatus =
  | 'IN_STOCK'
  | 'RESERVED'
  | 'SOLD'
  | 'DAMAGED'
  | 'RETURNED'
  | 'IN_TRANSIT'
  | 'RETURNED_TO_SUPPLIER';

export interface SerialNumber {
  id: string;
  variantId: string;
  serial: string;
  status: SerialStatus;
  currentWarehouseId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What every stock mutation returns. `averageCost`/`cogsPerUnit` are
 *  present only for a caller holding `products.view_cost`. */
export interface StockMutationResult {
  movementId: string;
  quantityOnHand: string;
  averageCost?: string;
  cogsPerUnit?: string;
}

// ------------------------------------------------------- Transfers -------
export type TransferStatus = 'DRAFT' | 'IN_TRANSIT' | 'COMPLETED' | 'CANCELLED';

export interface TransferItem {
  id: string;
  stockTransferId: string;
  variantId: string;
  quantity: string;
  quantityReceived: string | null;
  variant?: { id: string; sku: string };
}

export interface StockTransfer {
  id: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  status: TransferStatus;
  createdBy: string | null;
  sentBy: string | null;
  sentAt: string | null;
  receivedBy: string | null;
  receivedAt: string | null;
  createdAt: string;
  items: TransferItem[];
  sourceWarehouse?: { id: string; name: string };
  destinationWarehouse?: { id: string; name: string };
}

// ----------------------------------------------------- Stock counts ------
export type StockCountStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'CANCELLED';

export interface StockCountItem {
  id: string;
  variantId: string;
  /** Snapshotted when the count was created. */
  expectedQuantity: string;
  actualQuantity: string | null;
  reason: string | null;
  variant?: { id: string; sku: string };
}

export interface StockCount {
  id: string;
  warehouseId: string;
  status: StockCountStatus;
  createdBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  items: StockCountItem[];
  warehouse?: { id: string; name: string };
}

/** `GET /inventory/reconciliation` — an integrity check, not a report. */
export interface ReconciliationResult {
  checked: number;
  discrepancies: {
    warehouseId: string;
    variantId: string;
    cachedQuantityOnHand: string;
    computedFromLedger: string;
    difference: string;
  }[];
}

// ------------------------------------------------------ Purchasing -------
/**
 * Phase 16. Traced to the live `purchasing` module — its controllers, the
 * zod schemas in `packages/shared-validation/src/purchasing.ts`, and the
 * Prisma models.
 *
 * NOTE WHAT IS *NOT* OPTIONAL HERE, unlike Catalogue and Inventory. A
 * purchase order's `unitCost`, `lineTotal`, `subtotal` and `totalAmount`
 * ARE the document — they are what the business agreed to pay a supplier
 * — and the live contract gates them with `purchases.view`, not with
 * `products.view_cost`. There is no purchase-cost sub-permission in the
 * permission matrix, and an audit of every purchasing response confirmed
 * none of them carries the PROTECTED figures (`Product.defaultCost`,
 * `ProductVariant.cost`, `StockBalance.averageCost`): variants are
 * projected to `{id, sku}` throughout. So these fields are typed
 * required, because they always arrive for anyone who may read the
 * document at all.
 */

export type PurchaseStatus = 'DRAFT' | 'APPROVED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';
export type PurchasePaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'CARD' | 'OTHER';

export interface Supplier {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxNumber: string | null;
  paymentTermsDays: number | null;
  isActive: boolean;
  createdAt: string;
  /** Server-computed outstanding payable. Never derived in the browser. */
  balance?: string;
}

export interface SupplierListResult {
  data: Supplier[];
  pagination: Pagination;
}

export interface SupplierFilters {
  search?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
}

export interface PurchaseItem {
  id: string;
  purchaseId: string;
  variantId: string;
  quantityOrdered: string;
  quantityReceived: string;
  quantityReturned: string;
  unitCost: string;
  taxAmount: string;
  discountAmount: string;
  lineTotal: string;
  variant?: { id: string; sku: string };
}

export interface PurchaseReceiptItem {
  id: string;
  purchaseItemId: string;
  variantId: string;
  quantityReceived: string;
  unitCost: string;
}

export interface PurchaseReceipt {
  id: string;
  receiptNumber: string;
  warehouseId: string;
  idempotencyKey: string | null;
  notes: string | null;
  receivedBy: string | null;
  receivedAt: string;
  items: PurchaseReceiptItem[];
}

export interface PurchaseReturnItem {
  id: string;
  purchaseItemId: string;
  variantId: string;
  quantity: string;
  unitCost: string;
}

export interface PurchaseReturn {
  id: string;
  returnNumber: string;
  warehouseId: string;
  reason: string | null;
  createdAt: string;
  items: PurchaseReturnItem[];
}

export interface PurchasePayment {
  id: string;
  amount: string;
  method: PurchasePaymentMethod;
  reference: string | null;
  notes: string | null;
  paidAt: string;
}

export interface PurchaseListRow {
  id: string;
  purchaseNumber: string;
  status: PurchaseStatus;
  supplierId: string;
  warehouseId: string;
  orderDate: string;
  expectedDate: string | null;
  subtotal: string;
  taxAmount: string;
  discountAmount: string;
  totalAmount: string;
  createdAt: string;
  supplier?: { id: string; name: string };
  warehouse?: { id: string; name: string };
}

export interface PurchaseDetail extends PurchaseListRow {
  notes: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  items: PurchaseItem[];
  receipts: PurchaseReceipt[];
  returns: PurchaseReturn[];
  payments: PurchasePayment[];
}

export interface PurchaseListResult {
  data: PurchaseListRow[];
  pagination: Pagination;
}

export interface PurchaseFilters {
  supplierId?: string;
  warehouseId?: string;
  status?: PurchaseStatus;
  page?: number;
  limit?: number;
}

// ----------------------------------------------------------- Sales -------
/**
 * Phase 17. Traced to the live `sales` module — its controller, the zod
 * schemas in `packages/shared-validation/src/sales.ts`, and the Prisma
 * models.
 *
 * COST AND PROFIT ARE OPTIONAL, AND ARE ADDED RATHER THAN STRIPPED here —
 * the opposite posture from Catalogue and Inventory, and equally safe.
 * `GetSaleUseCase` computes `totalCost`/`grossProfit` on demand and
 * ATTACHES them only for a caller holding `products.view_cost`; there is
 * no cost column on Sale or SaleItem at all, so nothing can leak by
 * accident. The receipt carries neither for ANYBODY — it is a document
 * handed to a customer.
 *
 * NOTE WHAT THE LIST DOES NOT CARRY: `paidAmount`, `remainingAmount` and
 * `paymentStatus` are computed by `computePaymentSummary` and exist only
 * on the DETAIL. A list row therefore cannot say whether a sale is
 * settled, and this app does not pretend otherwise — see
 * `lib/sales.ts`.
 */

export type SaleStatus = 'COMPLETED' | 'VOIDED';
export type SalePaymentStatus = 'PAID' | 'PARTIALLY_PAID' | 'UNPAID';
export type SalePaymentMethod = 'CASH' | 'CARD' | 'WALLET' | 'OTHER';

export interface SaleListRow {
  id: string;
  saleNumber: string;
  status: SaleStatus;
  branchId: string;
  warehouseId: string;
  customerId: string | null;
  shiftId: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
  notes: string | null;
  createdAt: string;
  exchangeForReturnId: string | null;
  customer: { id: string; name: string } | null;
  warehouse: { id: string; name: string } | null;
}

export interface SaleListResult {
  data: SaleListRow[];
  pagination: Pagination;
}

/** The five filters the live list query accepts. There is deliberately no
 *  date range and no status filter — neither exists in the contract. */
export interface SaleFilters {
  saleNumber?: string;
  customerId?: string;
  warehouseId?: string;
  branchId?: string;
  shiftId?: string;
  page?: number;
  limit?: number;
}

export interface SaleItemRow {
  id: string;
  variantId: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxAmount: string;
  taxRateSnapshot: string | null;
  taxExempt: boolean;
  lineTotal: string;
  quantityReturned: string;
  variant?: { id: string; sku: string };
}

export interface SalePaymentRow {
  id: string;
  amount: string;
  method: SalePaymentMethod;
  reference: string | null;
  receivedAt: string;
}

export interface SaleReturnRow {
  id: string;
  returnNumber: string;
  refundMethod: string | null;
  refundAmount: string | null;
  reason: string | null;
  createdAt: string;
  items: { id: string; saleItemId: string; variantId: string; quantity: string; unitPrice: string; condition: string }[];
}

export interface SaleDetail extends SaleListRow {
  paidAmount: string;
  remainingAmount: string;
  paymentStatus: SalePaymentStatus;
  items: SaleItemRow[];
  payments: SalePaymentRow[];
  returns: SaleReturnRow[];
  shift: { id: string; openedBy: string; openedAt: string } | null;
  /** Both gated by `products.view_cost` — absent, not null, when not held. */
  totalCost?: string;
  grossProfit?: string;
}

/**
 * `GET /sales/:id/receipt` — the frozen Phase 10I contract, extended
 * additively in Phase 12 with `serialUnits` and `promotions`. Reproduced
 * here rather than imported because the two apps are separate packages;
 * the shape is the POS's, field for field.
 */
export interface SaleReceipt {
  business: {
    name: string;
    legalName: string | null;
    taxNumber: string | null;
    phone: string | null;
    email: string | null;
    addressLine: string | null;
    city: string | null;
    country: string | null;
    logoUrl: string | null;
    receiptHeader: string | null;
    receiptFooter: string | null;
    currency: string;
    displayName: string;
  };
  branch: { id: string; name: string; address: string | null; phone: string | null };
  register: { id: string; name: string; code: string } | null;
  cashier: { id: string; name: string } | null;
  sale: {
    id: string;
    saleNumber: string;
    createdAt: string;
    notes: string | null;
    subtotal: string;
    discountAmount: string;
    taxAmount: string;
    totalAmount: string;
    paidAmount: string;
    remainingAmount: string;
    paymentStatus: SalePaymentStatus;
    exchangeForReturn: { id: string; returnNumber: string } | null;
  };
  customer: { id: string; name: string; phone: string | null } | null;
  items: {
    id: string;
    sku: string;
    name: string;
    alternativeName: string | null;
    quantity: string;
    unitPrice: string;
    discountAmount: string;
    taxAmount: string;
    taxRatePercent: string | null;
    taxExempt: boolean;
    lineTotal: string;
    quantityReturned: string;
    serials: string[];
    serialUnits: { id: string; serial: string }[];
    /** The promotional part of `discountAmount`, snapshotted at the time
     *  of sale. These do NOT sum to `discountAmount` — a manual discount
     *  and a loyalty redemption live in that figure too — and nothing in
     *  this app may add them up. */
    promotions: { name: string; type: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'BUY_X_GET_Y'; discountApplied: string }[];
  }[];
  taxBreakdown: { ratePercent: string; taxableAmount: string; taxAmount: string }[];
  payments: { method: SalePaymentMethod | 'EXCHANGE_CREDIT'; amount: string; reference: string | null; receivedAt: string }[];
  loyalty: { earned: string; redeemed: string };
  returns: { returnNumber: string; createdAt: string; refundMethod: string | null; refundAmount: string | null }[];
}

export interface SaleCustomer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  isActive: boolean;
}

// ====================================================================
// Phase 18 — CUSTOMERS.
//
// Every shape below is the LIVE one, read off the running backend rather
// than assumed. Two absences are load-bearing and are recorded here so no
// screen invents them:
//
//   - there is NO `creditLimit` on the Customer model, in the create
//     schema or in the update schema. A credit limit sent to either
//     endpoint is silently stripped by a non-strict Zod object, so a UI
//     offering the field would appear to save a number that was never
//     stored.
//   - `isActive` is NOT writable through PATCH either. It is set true at
//     creation and false by DELETE, and nothing reverses it — see
//     `CUSTOMER_REACTIVATION_UNSUPPORTED` in `lib/customers.ts`.
// ====================================================================

/** `GET /sales/customers` row. `balance` is the SERVER's ledger sum. */
export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxNumber: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** `SUM(CustomerTransaction.amount)`, computed on every read. Positive
   *  means the customer owes the business. Never stored, never summed
   *  here. */
  balance: string;
}

export interface CustomerListResult {
  data: CustomerRow[];
  pagination: Pagination;
}

/** The three filters the live list query accepts, and no others. */
export interface CustomerFilters {
  /** Name OR phone, `contains`; an EXACT phone match is ranked first by
   *  the server, which is why the browser never re-sorts the page. */
  search?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
}

export type CustomerTransactionType = 'SALE' | 'SALE_RETURN' | 'PAYMENT' | 'OPENING_BALANCE' | 'ADJUSTMENT';

export interface CustomerTransactionRow {
  id: string;
  type: CustomerTransactionType;
  amount: string;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  createdAt: string;
}

/** `GET /sales/customers/:id`. The last 100 ledger rows, newest first —
 *  the server takes 100 and offers no paging over them. */
export interface CustomerDetail extends CustomerRow {
  recentTransactions: CustomerTransactionRow[];
}

/** The exact five fields `createCustomerSchema` accepts. */
export interface CustomerInput {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  taxNumber?: string;
}

export type CustomerPointsType = 'EARN' | 'REDEEM' | 'RETURN_CLAWBACK' | 'ADJUSTMENT';

/** `GET /sales/customers/:id/points` — `loyalty.view`. */
export interface CustomerPointsBalance {
  customerId: string;
  customerName: string;
  balance: string;
  eventCount: number;
  /** The server says so on the response itself: the balance is derived
   *  from the ledger on every read and is never cached. */
  derivation: string;
}

export interface CustomerPointsRow {
  id: string;
  type: CustomerPointsType;
  /** Signed. Positive adds, negative removes; never zero. */
  points: string;
  basisAmount: string | null;
  rateSnapshot: string | null;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  createdAt: string;
}

/** `GET /sales/customers/:id/points/ledger` — `loyalty.view`. `balance`
 *  is the WHOLE customer's balance, never this page's subtotal and never
 *  affected by the `type` filter. */
export interface CustomerPointsLedger {
  data: CustomerPointsRow[];
  balance: string;
  pagination: Pagination;
}

/** `POST /sales/customers/:id/points/adjust` — `loyalty.adjust`. */
export interface AdjustPointsInput {
  points: number;
  reason: string;
  idempotencyKey: string;
}

// ====================================================================
// Phase 19 — REPORTING & ANALYTICS.
//
// Every shape below is the LIVE one, read off the running backend. Three
// facts about this family shape all of it:
//
//   1. COST AND PROFIT KEYS ARE OPTIONAL EVERYWHERE THEY APPEAR. The
//      server DELETES them for a caller lacking `products.view_cost` /
//      `reports.view_profit` rather than nulling them, so every such
//      field is `?:` and every screen asks whether the response CARRIED
//      it — never whether a grant is held.
//   2. THE FINANCIAL FAMILY IS THE DOCUMENTED EXCEPTION. Owner Decision
//      (Phase 19): `reports.financial.view` IMPLIES visibility of the
//      financial reports' own contents, so P&L, Balance Sheet, the
//      General Ledger and the inventory-GL reconciliation carry their
//      figures unconditionally for any holder of that grant. Those
//      fields are therefore REQUIRED, not optional.
//   3. `limitations` IS PART OF THE CONTRACT. The server states in prose
//      what each figure does NOT include; the screens print it verbatim.
// ====================================================================

export interface ReportRange {
  from: string;
  /** EXCLUSIVE. The server resolves an inclusive calendar `to` into the
   *  instant starting the next day, in the BUSINESS's own timezone. */
  to: string;
  timezone: string;
}

/** The window control's own state. `from`/`to` are `YYYY-MM-DD` calendar
 *  dates as the caller types them; the server owns their interpretation. */
export interface ReportRangeParams {
  from?: string;
  to?: string;
  branchId?: string;
}

// ------------------------------------------------------------- Sales -----

export interface SalesSummary {
  subtotal: string;
  discountAmount: string;
  netSales: string;
  taxAmount: string;
  totalAmount: string;
  transactionCount: number;
  averageInvoice: string;
  returnedQuantity: string;
  /** `products.view_cost`. */
  cogs?: string;
  /** `reports.view_profit`. */
  grossProfit?: string;
}

export interface SalesSummaryResult {
  data: SalesSummary;
  range: ReportRange;
}

/** One row of any of the five by-dimension reports — the same shape for
 *  all of them, which is why one screen renders all five. */
export interface DimensionRow {
  key: string;
  label: string;
  quantity: string;
  netSales: string;
  transactionCount: number;
  /** `products.view_cost`. */
  cogs?: string;
  /** `reports.view_profit`. */
  grossProfit?: string;
}

export interface DimensionResult {
  data: DimensionRow[];
  pagination: Pagination;
  range: ReportRange;
}

export interface SalesReturnReportRow {
  id: string;
  returnNumber: string;
  saleId: string;
  saleNumber: string;
  isWalkIn: boolean;
  returnValue: string;
  createdAt: string;
  items: { variantId: string; sku: string; productName: string; quantity: string; unitPrice: string; condition: string }[];
}

export interface SalesReturnsResult {
  data: SalesReturnReportRow[];
  summary: {
    sellableValue: string;
    damagedValue: string;
    customerReturnValue: string;
    walkInReturnValue: string;
    glRevenueReversalNote: string;
  };
  pagination: Pagination;
  range: ReportRange;
}

export interface PurchasingSummary {
  receiptCount: number;
  receivedQuantity: string;
  returnCount: number;
  returnedQuantity: string;
  paidToSuppliers: string;
  /** All three `products.view_cost`. */
  totalCost?: string;
  returnedCost?: string;
  netPurchaseCost?: string;
}

export interface PurchasingSummaryResult {
  data: PurchasingSummary;
  range: ReportRange;
}

// --------------------------------------------------------- Inventory -----

export interface ValuationRow {
  variantId: string;
  sku: string;
  productName: string;
  warehouseId: string;
  warehouseName: string;
  quantityOnHand: string;
  averageCost?: string;
  inventoryValue?: string;
}

export interface ValuationResult {
  data: ValuationRow[];
  summary: { variantCount: number; inventoryValue?: string };
  pagination: Pagination;
}

export interface MovementReportRow {
  id: string;
  createdAt: string;
  movementType: string;
  variantId: string;
  sku: string;
  productName: string;
  warehouseName: string;
  quantityBase: string;
  referenceType: string | null;
  referenceId: string | null;
  reason: string | null;
  isNegativeStock: boolean;
  unitCostAtMovement?: string;
  movementValue?: string;
}

export interface MovementReportResult {
  data: MovementReportRow[];
  pagination: Pagination;
  range: ReportRange;
}

export interface DamageLossRow {
  id: string;
  createdAt: string;
  movementType: string;
  sku: string;
  productName: string;
  quantity: string;
  reason: string | null;
  unitCostAtMovement?: string;
  movementValue?: string;
}

export interface DamageLossResult {
  data: DamageLossRow[];
  summary: { movementType: string; quantity: string; movementCount: number; movementValue?: string }[];
  pagination: Pagination;
  range: ReportRange;
}

export interface SlowMovingRow {
  variantId: string;
  sku: string;
  productName: string;
  warehouseId: string;
  warehouseName: string;
  quantityOnHand: string;
  lastSaleAt: string | null;
  daysWithoutSale: number;
  averageCost?: string;
  inventoryValue?: string;
}

export interface SlowMovingResult {
  data: SlowMovingRow[];
  pagination: Pagination;
  criteria: { days: number; definition: string };
}

// --------------------------------------------------------- Financial -----

export interface GeneralLedgerRow {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  sourceType: string;
  sourceId: string | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  debit: string;
  credit: string;
  description: string | null;
}

export interface GeneralLedgerResult {
  data: GeneralLedgerRow[];
  pagination: Pagination;
  range: ReportRange;
}

/** Owner Decision (Phase 19): required, not optional — `reports.financial.view`
 *  carries the whole statement, profit lines included. */
export interface ProfitAndLossResult {
  data: {
    netRevenue: string;
    costOfGoodsSold: string;
    grossProfit: string;
    inventoryRelatedOperatingExpenses: { inventoryShrinkage: string; internalConsumption: string; total: string };
    otherIncome: string;
    netProfit: string;
  };
  limitations: Record<string, string>;
  range: ReportRange;
}

export interface BalanceSheetAccount {
  accountId: string;
  code: string;
  name: string;
  balance: string;
}

export interface BalanceSheetResult {
  data: {
    asAt: string;
    assets: { accounts: BalanceSheetAccount[]; total: string };
    liabilities: { accounts: BalanceSheetAccount[]; total: string };
    equity: { accounts: BalanceSheetAccount[]; currentPeriodEarnings: string; total: string };
    totalLiabilitiesAndEquity: string;
    /** The server's own equation check — never recomputed here. */
    balanced: boolean;
  };
  limitations: Record<string, string>;
}

export interface PartyBalanceRow {
  id: string;
  name: string;
  balance: string;
}

export interface ReceivablesResult {
  data: PartyBalanceRow[];
  summary: { totalReceivable?: string; totalPayable?: string; customerCount?: number; supplierCount?: number };
  pagination: Pagination;
  limitations: Record<string, string>;
}

// ---------------------------------------------------- Reconciliation -----

export interface ReconciliationExclusion {
  excludedBy: string;
  movementType: string;
  reason: string;
  excludedValue?: string;
  excludedMovementCount?: number;
}

export interface ReconciliationResult {
  summary: {
    sourceA: string;
    sourceB: string;
    expectedRelationship: string;
    exclusions?: ReconciliationExclusion[];
    reconciled?: boolean;
    discrepancyCount?: number;
    [key: string]: unknown;
  };
  data: Record<string, unknown>[];
  pagination: Pagination;
}
