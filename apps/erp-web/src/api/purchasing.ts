import { api } from '../lib/apiClient';
import type {
  PurchaseDetail,
  PurchaseFilters,
  PurchaseListResult,
  PurchasePaymentMethod,
  Supplier,
  SupplierFilters,
  SupplierListResult,
} from '../lib/apiTypes';

/**
 * Phase 16 — purchasing and suppliers, consumed exactly as the live
 * backend defines them.
 *
 * NOT ONE ENDPOINT WAS ADDED. Suppliers, purchase orders, the whole
 * DRAFT → APPROVED → RECEIVED lifecycle, receiving with serials,
 * returns and payments all existed and were re-read before a line of UI
 * was written.
 *
 * NO PURCHASE ARITHMETIC HAPPENS IN THIS APP. The server computes
 * `lineTotal`, `subtotal`, `taxAmount` and `totalAmount` on create and
 * on edit, and returns them; receiving posts the inventory movement AND
 * the journal entry in one transaction under its own document lock.
 * There is deliberately no client-side total preview — see
 * `lib/purchasing.ts`.
 */
export const purchasingApi = {
  // -------------------------------------------------------- suppliers --
  /** `suppliers.view`. Server-side search, isActive filter and pagination. */
  listSuppliers: (filters: SupplierFilters = {}) => {
    const q = new URLSearchParams();
    if (filters.search) q.set('search', filters.search);
    if (filters.isActive !== undefined) q.set('isActive', String(filters.isActive));
    q.set('page', String(filters.page ?? 1));
    q.set('limit', String(filters.limit ?? 50));
    return api.get<SupplierListResult>(`/purchasing/suppliers?${q.toString()}`);
  },

  getSupplier: (id: string) => api.get<{ data: Supplier }>(`/purchasing/suppliers/${id}`),

  createSupplier: (body: Record<string, unknown>) => api.post<{ data: Supplier }>('/purchasing/suppliers', body),

  updateSupplier: (id: string, body: Record<string, unknown>) =>
    api.patch<{ data: Supplier }>(`/purchasing/suppliers/${id}`, body),

  /**
   * `suppliers.delete`. SOFT delete only — the backend sets `isActive`
   * false and refuses outright when the supplier still has an open
   * purchase. Nothing is destroyed, so the purchase history that
   * references them stays readable.
   */
  deactivateSupplier: (id: string) => api.delete<{ data: Supplier }>(`/purchasing/suppliers/${id}`),

  // -------------------------------------------------------- purchases --
  listPurchases: (filters: PurchaseFilters = {}) => {
    const q = new URLSearchParams();
    if (filters.supplierId) q.set('supplierId', filters.supplierId);
    if (filters.warehouseId) q.set('warehouseId', filters.warehouseId);
    if (filters.status) q.set('status', filters.status);
    q.set('page', String(filters.page ?? 1));
    q.set('limit', String(filters.limit ?? 50));
    return api.get<PurchaseListResult>(`/purchasing/purchases?${q.toString()}`);
  },

  getPurchase: (id: string) => api.get<{ data: PurchaseDetail }>(`/purchasing/purchases/${id}`),

  /** `purchases.create`. `branchId` is deliberately NOT sent: the server
   *  derives it from the warehouse, so a caller can never supply a
   *  mismatched pair. */
  createPurchase: (body: {
    warehouseId: string;
    supplierId: string;
    expectedDate?: string;
    notes?: string;
    items: { variantId: string; quantityOrdered: number; unitCost: number; taxAmount?: number; discountAmount?: number }[];
  }) => api.post<{ data: PurchaseDetail }>('/purchasing/purchases', body),

  /** `purchases.edit` — DRAFT only, which the server enforces with a 409. */
  updatePurchase: (id: string, body: Record<string, unknown>) =>
    api.patch<{ data: PurchaseDetail }>(`/purchasing/purchases/${id}`, body),

  /** `purchases.approve` — DRAFT → APPROVED. Its own grant: the person who
   *  raises an order is not necessarily the one who commits the business
   *  to it. Posts no accounting. */
  approvePurchase: (id: string) => api.post<{ data: PurchaseDetail }>(`/purchasing/purchases/${id}/approve`, {}),

  /** `purchases.cancel` — from DRAFT, APPROVED or PARTIALLY_RECEIVED. */
  cancelPurchase: (id: string, reason?: string) =>
    api.post<{ data: PurchaseDetail }>(`/purchasing/purchases/${id}/cancel`, reason ? { reason } : {}),

  /**
   * `purchases.receive`. THE ONLY PLACE PURCHASING TOUCHES STOCK, and it
   * does so through InventoryEngineService inside one transaction that
   * also writes the receipt, the document's running total, the supplier
   * payable and the journal entry.
   *
   * `idempotencyKey` is part of the live contract: a replay with the same
   * key and the same delivery returns the original receipt instead of
   * receiving twice, and a replay naming a DIFFERENT delivery is
   * rejected. Serials are required for a serial-tracked variant and
   * refused for one that is not — the server decides which, because only
   * it knows the product's tracking flag.
   */
  receivePurchase: (
    id: string,
    body: {
      notes?: string;
      idempotencyKey?: string;
      items: { purchaseItemId: string; quantityReceived: number; serials?: string[] }[];
    },
  ) => api.post<{ data: unknown }>(`/purchasing/purchases/${id}/receive`, body),

  /** `purchases.return` — goods back to the supplier. Serial-tracked units
   *  must be named and must be IN_STOCK at the purchase's warehouse. */
  createPurchaseReturn: (
    id: string,
    body: { reason?: string; items: { purchaseItemId: string; quantity: number; serials?: string[] }[] },
  ) => api.post<{ data: unknown }>(`/purchasing/purchases/${id}/returns`, body),

  /** `purchases.pay` — its own grant again, held by the ACCOUNTANT and not
   *  by the buyer who raised the order. */
  createPurchasePayment: (
    id: string,
    body: { amount: number; method: PurchasePaymentMethod; reference?: string; notes?: string },
  ) => api.post<{ data: unknown }>(`/purchasing/purchases/${id}/payments`, body),
};
