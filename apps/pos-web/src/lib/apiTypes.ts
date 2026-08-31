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

export interface CashTransaction {
  id: string;
  businessId: string;
  shiftId: string;
  type: 'PAY_IN' | 'PAY_OUT';
  amount: string;
  reason: string;
  createdBy: string;
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
    serials: string[];
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
