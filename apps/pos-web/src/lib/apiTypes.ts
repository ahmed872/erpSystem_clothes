/**
 * Types mirroring the ACTUAL backend contracts (apps/api), verified against
 * the live controllers/Zod schemas — not invented. Every money field is a
 * `Decimal` server-side; `Decimal#toJSON` serializes it as a numeric
 * STRING over the wire, so every money field here is typed `string` and
 * must be parsed before arithmetic (see lib/money.ts) and sent back
 * formatted as a plain number in request bodies (Zod's `nonNegativeMoneySchema`
 * etc. are `z.number()`, not strings).
 *
 * Fields that are OMITTED (not null) for a caller lacking the permission
 * that gates them (cost, profit, expected-cash) are typed optional (`?`).
 */

export type PermissionCode = string;

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export interface Paginated<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

// ---------------------------------------------------------------- Auth ----

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

// --------------------------------------------------------- Permissions ----

export interface MyPermissionsResult {
  permissions: PermissionCode[];
}

// -------------------------------------------------------------- Shifts ----

export interface PosWarehouseOption {
  id: string;
  name: string;
  branchId: string;
  branchName: string;
  isDefault: boolean;
}

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
  /** Present only for a caller holding `shifts.view_expected` (blind close). */
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

/**
 * Phase 10 (BD-17) — one movement of PHYSICAL cash through a drawer.
 *
 * `amount` is SIGNED by the server from the type, and a database CHECK
 * enforces the agreement: SALE_TENDER and PAY_IN are positive, SALE_REFUND,
 * PAY_OUT and EXPENSE negative. Non-cash tenders never appear here at all —
 * card and wallet post to their own clearing accounts and never enter the
 * drawer.
 *
 * `GET /sales/shifts/:id/cash-transactions` returns EVERY type, not only the
 * two a cashier can key in by hand. Typing it as PAY_IN | PAY_OUT (as this
 * did before the Cash Drawer milestone) silently mislabelled every sale
 * tender and refund the list contains.
 */
export type CashTransactionType = 'SALE_TENDER' | 'SALE_REFUND' | 'PAY_IN' | 'PAY_OUT' | 'EXPENSE';

export interface CashTransaction {
  id: string;
  businessId: string;
  shiftId: string;
  type: CashTransactionType;
  /** Signed. Negative = cash left the drawer. */
  amount: string;
  referenceType: string | null;
  referenceId: string | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

// ------------------------------------------------------------- Catalog ----

export interface AttributeValue {
  id: string;
  attributeId: string;
  value: string;
  attribute: { id: string; name: string };
}

export interface VariantAttributeValue {
  attributeId: string;
  attributeValueId: string;
  attributeValue: AttributeValue;
}

export interface Barcode {
  id: string;
  variantId: string;
  code: string;
  isPrimary: boolean;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  alternativeName: string | null;
  type: 'SIMPLE' | 'BUNDLE';
  status: 'ACTIVE' | 'INACTIVE' | 'DISCONTINUED';
  defaultCost?: string;
  defaultSellingPrice: string;
  tracksSerialNumbers: boolean;
  taxExempt: boolean;
  category: { id: string; name: string } | null;
  brand: { id: string; name: string } | null;
}

export interface ProductVariant {
  id: string;
  productId: string;
  sku: string;
  status: 'ACTIVE' | 'INACTIVE' | 'DISCONTINUED';
  cost?: string;
  sellingPrice: string;
  product: Product;
  attributeValues: VariantAttributeValue[];
  barcodes: Barcode[];
}

export interface StockBalance {
  id: string;
  warehouseId: string;
  variantId: string;
  quantityOnHand: string;
  quantityReserved: string;
  averageCost?: string;
  availableQuantity: string;
  variant: { id: string; sku: string; product: { id: string; name: string } };
  warehouse: { id: string; name: string };
}

// ------------------------------------------------------------ Customers ----

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxNumber: string | null;
  isActive: boolean;
  balance?: string;
}

// ------------------------------------------------------------- Loyalty ----

export interface CustomerPointsBalance {
  customerId: string;
  customerName: string;
  balance: string;
  eventCount: number;
}

// --------------------------------------------------------------- Sales ----

export type SalePaymentMethod = 'CASH' | 'CARD' | 'WALLET' | 'OTHER';

export interface SaleItemInput {
  variantId: string;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
  taxExempt?: boolean;
  serials?: string[];
}

export interface SalePaymentInput {
  amount: number;
  method: SalePaymentMethod;
  reference?: string;
}

export interface CreateSaleInput {
  warehouseId: string;
  customerId?: string;
  notes?: string;
  idempotencyKey?: string;
  items: SaleItemInput[];
  redeemPoints?: number;
  payments: SalePaymentInput[];
}

/**
 * Phase 12 (Sale Quote) — what `POST /sales/quote` answers.
 *
 * Every money field is a decimal string, exactly as the sale will store
 * it. `totals.amountDue` is the figure to tender on `POST /sales`: the
 * server's exact-payment rule is satisfied by sending precisely this.
 */
export interface QuoteSaleInput {
  warehouseId: string;
  customerId?: string;
  items: SaleItemInput[];
  redeemPoints?: number;
}

export interface SaleQuoteLine {
  variantId: string;
  sku: string;
  quantity: string;
  unitPrice: string;
  lineGross: string;
  manualDiscount: string;
  promotionDiscount: string;
  loyaltyDiscount: string;
  discountAmount: string;
  taxId: string | null;
  taxRatePercent: string | null;
  taxExempt: boolean;
  taxAmount: string;
  lineTotal: string;
  promotion: { id: string; name: string; type: string } | null;
  requiresSerials: boolean;
}

export interface SaleQuote {
  warehouseId: string;
  customerId: string | null;
  currency: string;
  lines: SaleQuoteLine[];
  totals: {
    subtotal: string;
    discountAmount: string;
    taxAmount: string;
    totalAmount: string;
    /** Tender exactly this. */
    amountDue: string;
  };
  loyalty: { pointsRequested: string; redemptionValue: string; redemptionRate: string | null };
  availability: { variantId: string; availableQuantity: string; requestedQuantity: string; sufficient: boolean }[];
  quotedAt: string;
  /** The server saying, in the payload, what it is and is not promising. */
  guarantees: {
    authoritativePricing: boolean;
    reservesStock: boolean;
    holdsPrices: boolean;
    holdsPromotions: boolean;
    holdsLoyaltyBalance: boolean;
    createsNothing: boolean;
  };
}

export interface SaleItem {
  id: string;
  saleId: string;
  variantId: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxRateSnapshot: string | null;
  taxExempt: boolean;
  taxAmount: string;
  lineTotal: string;
  quantityReturned: string;
}

/**
 * Phase 12 (Returns) — what `POST /sales/:id/returns/preview` answers.
 *
 * `totals.totalRefundable` is BD-1's merchandise credit plus BD-18's
 * cumulative tax reversal, computed by the same functions the real return
 * calls. `refund.requiredAmount` is the exact figure a WALK-IN must be
 * handed; for an account customer it is null and anything up to
 * `refund.maxAmount` is allowed, with the remainder going to their ledger.
 */
export interface SaleReturnPreviewLine {
  saleItemId: string;
  variantId: string;
  sku: string;
  name: string;
  alternativeName: string | null;
  quantity: string;
  quantitySold: string;
  quantityAlreadyReturned: string;
  quantityAvailableToReturn: string;
  condition: 'SELLABLE' | 'DAMAGED';
  requiresSerials: boolean;
  serials: string[];
  merchandiseCredit: string;
  taxReversal: string;
  lineRefundable: string;
}

export interface SaleReturnPreview {
  sale: { id: string; saleNumber: string; createdAt: string; shiftId: string; totalAmount: string };
  customer: { id: string; name: string; isActive: boolean } | null;
  isWalkIn: boolean;
  lines: SaleReturnPreviewLine[];
  totals: { merchandiseCredit: string; taxReversal: string; totalRefundable: string };
  refund: {
    required: boolean;
    requiredAmount: string | null;
    maxAmount: string;
    creditToLedgerIfNoRefund: string;
  };
  previewedAt: string;
  guarantees: {
    authoritativeCredit: boolean;
    reservesNothing: boolean;
    createsNothing: boolean;
    finalReturnRevalidates: boolean;
  };
}

export interface PreviewSaleReturnInput {
  items: Array<{
    saleItemId: string;
    quantity: number;
    condition?: 'SELLABLE' | 'DAMAGED';
    serials?: string[];
  }>;
}

export interface SalePayment {
  id: string;
  saleId: string;
  amount: string;
  method: SalePaymentMethod | 'EXCHANGE_CREDIT';
  reference: string | null;
  receivedAt: string;
}

export interface Sale {
  id: string;
  businessId: string;
  branchId: string;
  warehouseId: string;
  customerId: string | null;
  shiftId: string;
  saleNumber: string;
  status: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
  notes: string | null;
  createdAt: string;
  items: SaleItem[];
  payments: SalePayment[];
}

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
    paymentStatus: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID';
    exchangeForReturn: { id: string; returnNumber: string } | null;
  };
  customer: { id: string; name: string; phone: string | null } | null;
  items: Array<{
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
    /** Serial STRINGS, as printed. Returns and Exchanges pick units by
     * these; neither needs an identity. */
    serials: string[];
    /** Phase 12 (Warranty): the same units, carrying the id
     * `POST /warranties` must name. See the server-side comment in
     * `get-sale-receipt.use-case.ts` for why the identity lives here and
     * not behind a variant-wide serial lookup. */
    serialUnits: Array<{ id: string; serial: string }>;
    /**
     * Phase 12 (approved decision D2) — the promotional part of
     * `discountAmount`, named.
     *
     * Snapshotted at the time of sale: `name` is the promotion's name AS
     * IT WAS, and `discountApplied` its effective contribution after the
     * server's cap. Empty for a line no promotion reached.
     *
     * These do NOT sum to `discountAmount` — a manual discount and a
     * loyalty redemption live in that figure too — and nothing in this app
     * may add them up. They are displayed, and only displayed.
     */
    promotions: Array<{ name: string; type: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'BUY_X_GET_Y'; discountApplied: string }>;
  }>;
  taxBreakdown: Array<{ ratePercent: string; taxableAmount: string; taxAmount: string }>;
  payments: Array<{ method: SalePaymentMethod | 'EXCHANGE_CREDIT'; amount: string; reference: string | null; receivedAt: string }>;
  loyalty: { earned: string; redeemed: string };
  returns: Array<{ returnNumber: string; createdAt: string; refundMethod: string | null; refundAmount: string | null }>;
}

export interface SaleListRow extends Sale {
  customer: { id: string; name: string } | null;
  warehouse: { id: string; name: string };
}

// -------------------------------------------------------------- Returns ----

export interface CreateSaleReturnItemInput {
  saleItemId: string;
  quantity: number;
  condition?: 'SELLABLE' | 'DAMAGED';
  serials?: string[];
}

export interface CreateSaleReturnInput {
  reason?: string;
  idempotencyKey?: string;
  refund?: { method: SalePaymentMethod; amount: number; reference?: string };
  items: CreateSaleReturnItemInput[];
}

export interface SaleReturnItem {
  id: string;
  saleReturnId: string;
  saleItemId: string;
  quantity: string;
  condition: 'SELLABLE' | 'DAMAGED';
}

export interface SaleReturn {
  id: string;
  saleId: string;
  warehouseId: string;
  returnNumber: string;
  refundMethod: string | null;
  refundAmount: string | null;
  refundReference: string | null;
  reason: string | null;
  createdAt: string;
  items: SaleReturnItem[];
  totalRefundable: string;
}

// ------------------------------------------------------------ Exchanges ----

/**
 * Phase 12 (Exchange preview) — what `POST /sales/:id/exchanges/preview`
 * answers. Composes the SAME `PreviewSaleReturnUseCase` computation (the
 * return half) and the SAME `quotePricing` pipeline (the replacement half)
 * the standalone return preview and sale quote already use — see the
 * backend's `PreviewExchangeUseCase` doc comment for exactly how.
 *
 * `direction` is server-decided, never inferred here:
 *   - EVEN: `amountDue` and `refundAmount` are both `'0'`.
 *   - UPWARD: tender exactly `totals.amountDue` on `POST .../exchanges`.
 *   - DOWNWARD: hand back exactly `totals.refundAmount`, with a method the
 *     cashier chooses — the AMOUNT is never editable, only the method.
 */
export type ExchangeDirection = 'EVEN' | 'UPWARD' | 'DOWNWARD';

export interface ExchangeNewLine {
  variantId: string;
  sku: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxAmount: string;
  taxRatePercent: string | null;
  lineTotal: string;
  promotion: { id: string; name: string; type: string } | null;
  requiresSerials: boolean;
}

export interface PreviewExchangeInput {
  returnItems: Array<{
    saleItemId: string;
    quantity: number;
    condition?: 'SELLABLE' | 'DAMAGED';
    serials?: string[];
  }>;
  newItems: SaleItemInput[];
  redeemPoints?: number;
}

export interface ExchangePreview {
  sale: { id: string; saleNumber: string; createdAt: string; shiftId: string; totalAmount: string };
  customer: { id: string; name: string; isActive: boolean } | null;
  isWalkIn: boolean;
  returnLines: SaleReturnPreviewLine[];
  newLines: ExchangeNewLine[];
  availability: { variantId: string; availableQuantity: string; requestedQuantity: string; sufficient: boolean }[];
  direction: ExchangeDirection;
  totals: {
    returnCredit: string;
    replacementTotal: string;
    creditApplied: string;
    /** Tender exactly this on `POST .../exchanges` — `'0'` unless UPWARD. */
    amountDue: string;
    /** Send this as `refund.amount` — `'0'` unless DOWNWARD. */
    refundAmount: string;
  };
  refund: { required: boolean; requiredAmount: string | null };
  previewedAt: string;
  guarantees: {
    authoritativeOutcome: boolean;
    reservesNothing: boolean;
    createsNothing: boolean;
    finalExchangeRevalidates: boolean;
  };
}

export interface CreateExchangeInput {
  idempotencyKey?: string;
  reason?: string;
  notes?: string;
  returnItems: PreviewExchangeInput['returnItems'];
  newItems: SaleItemInput[];
  /** Real tender for an UPWARD exchange. Never carries `EXCHANGE_CREDIT` —
   * that method exists only for the server to produce. */
  payments: SalePaymentInput[];
  /** Real money back for a DOWNWARD exchange. The AMOUNT is proved by the
   * server against the two totals; only the METHOD is genuinely a client
   * input. Omit entirely for an EVEN or UPWARD exchange. */
  refund?: { method: SalePaymentMethod; amount: number; reference?: string };
  redeemPoints?: number;
}

export interface ExchangeResult {
  saleReturn: SaleReturn;
  sale: Sale;
  exchangeCredit: string;
  amountDue: string;
  refunded: string;
}

// ---------------------------------------------------------- Held sales ----

/**
 * Phase 12 (Held Sales) — a PARKED BASKET, exactly as the backend stores
 * it (`apps/api/prisma/schema.prisma`, models `HeldSale`/`HeldSaleItem`).
 *
 * Read the item shape carefully: it is `SaleItemInput` with the values as
 * decimal strings, and NOTHING ELSE. There is no subtotal, no tax, no
 * promotion, no loyalty and no total on a hold, because a hold is a stored
 * REQUEST and not a half-computed sale — those figures come into existence
 * when the basket is resumed, from the configuration in force at that
 * moment. Any total this app shows for a hold is therefore an explicitly
 * labelled indication, never an authoritative figure.
 */
export type HeldSaleStatus = 'OPEN' | 'RESUMED' | 'VOIDED';

export interface HeldSaleItem {
  id: string;
  heldSaleId: string;
  variantId: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxExempt: boolean;
  serials: string[];
}

export interface HeldSale {
  id: string;
  businessId: string;
  branchId: string;
  warehouseId: string;
  customerId: string | null;
  shiftId: string;
  holdNumber: string;
  status: HeldSaleStatus;
  label: string | null;
  notes: string | null;
  resumedSaleId: string | null;
  resumedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdBy: string;
  createdAt: string;
  items: HeldSaleItem[];
}

/** Deliberately carries no `payments` and no `redeemPoints`: money is
 * tendered when goods change hands, not when a basket is put aside. */
export interface CreateHeldSaleInput {
  warehouseId: string;
  customerId?: string;
  label?: string;
  notes?: string;
  items: SaleItemInput[];
}

export interface UpdateHeldSaleInput {
  customerId?: string | null;
  label?: string | null;
  notes?: string | null;
  items?: SaleItemInput[];
}

/** Only what could not have been known when the basket was parked. The
 * goods, warehouse and customer come from the hold itself. */
export interface ResumeHeldSaleInput {
  idempotencyKey?: string;
  payments: SalePaymentInput[];
  redeemPoints?: number;
  notes?: string;
}

export interface ResumeHeldSaleResult {
  heldSale: HeldSale;
  sale: Sale;
}

/** `GET /sales/holds` answers with `meta`, not the `pagination` envelope
 * the catalogue/customer lists use. */
export interface HeldSaleList {
  data: HeldSale[];
  meta: { total: number; page: number; limit: number };
}

// ------------------------------------------------------------ Warranty ----

/**
 * Phase 8A/8E — a warranty covers ONE physical serial unit sold on ONE
 * sale line. Everything about its validity is the server's answer.
 *
 * `status` is the STORED value (a human action set it); `effectiveStatus`
 * is the time-aware one the server derives on read, because no scheduled
 * job flips ACTIVE to EXPIRED. **Display `effectiveStatus`.** The dates are
 * snapshotted at registration and never recomputed from current
 * configuration, so a warranty's coverage cannot be widened or narrowed
 * after the fact — which is also why the browser must never evaluate them
 * itself.
 */
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
  /** The one to show: date-aware, computed by the server on read. */
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
  saleItem: { id: string; variantId: string; quantity: string; sale: { id: string; saleNumber: string; createdAt: string; branchId: string } };
  claims: WarrantyClaim[];
}

/** Deliberately carries no dates: `startDate` is the SALE's own createdAt
 * and `durationDays` falls back to the business default. A till does not
 * invent warranty periods. */
export interface RegisterWarrantyInput {
  saleItemId: string;
  serialNumberId: string;
  durationDays?: number;
  notes?: string;
}

/**
 * Phase 12 (approved decision D4) — what an exact serial resolves to.
 *
 * Deliberately narrow: which unit, and which sale delivered it. Enough to
 * enter Returns or Warranty, and nothing more — no cost, no margin, no
 * other unit from the same sale, no customer contact details.
 */
export interface SerialLookupResult {
  serialNumberId: string;
  serial: string;
  status: 'IN_STOCK' | 'RESERVED' | 'SOLD' | 'DAMAGED' | 'RETURNED';
  variantId: string;
  sku: string;
  productName: string;
  alternativeName: string | null;
  /** Null when the unit is in this shop's stock but has not been sold. */
  sale: {
    id: string;
    saleNumber: string;
    soldAt: string;
    saleItemId: string;
    customer: { id: string; name: string } | null;
  } | null;
}
