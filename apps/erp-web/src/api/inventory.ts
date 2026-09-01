import { api } from '../lib/apiClient';
import type {
  AdjustmentType,
  InventoryLot,
  MovementFilters,
  MovementListResult,
  ReconciliationResult,
  SerialNumber,
  SerialStatus,
  StockBalance,
  StockCount,
  StockMutationResult,
  StockTransfer,
  Warehouse,
} from '../lib/apiTypes';

/**
 * Phase 15 — inventory, consumed exactly as the live backend defines it.
 *
 * NOT ONE ENDPOINT WAS ADDED. Balances, movements, lots, serials,
 * adjustments, the full transfer lifecycle and stock counts all existed
 * and were re-read before a line of UI was written.
 *
 * THE ENGINE IS NOT REIMPLEMENTED HERE, in any form. Every quantity this
 * app shows is one the server computed: `availableQuantity` is
 * `quantityOnHand - quantityReserved` server-side, a mutation's resulting
 * `quantityOnHand` comes back from the engine under its own
 * `SELECT ... FOR UPDATE`, and no screen adds, subtracts or predicts a
 * balance. There is deliberately no client-side "what will this leave me
 * with" preview: it would be a second inventory engine that could
 * disagree with the one that actually writes.
 *
 * WHAT IS UNPAGINATED, and consumed as-is: balances, lots, serials and
 * transfers take no page/limit. Only `/inventory/movements` paginates.
 */
export const inventoryApi = {
  /** `warehouses.view` — not an inventory grant. A CASHIER holds
   *  `inventory.view` but NOT this, so the warehouse filter is gated
   *  separately from the balances it filters. */
  listWarehouses: () => api.get<{ data: Warehouse[] }>('/warehouses'),

  /** `inventory.view`. Unpaginated; filters are the server's two. */
  balances: (params: { warehouseId?: string; variantId?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.warehouseId) q.set('warehouseId', params.warehouseId);
    if (params.variantId) q.set('variantId', params.variantId);
    const qs = q.toString();
    return api.get<{ data: StockBalance[] }>(`/inventory/balances${qs ? `?${qs}` : ''}`);
  },

  /** `inventory.view`. The ONE paginated inventory read. */
  movements: (filters: MovementFilters = {}) => {
    const q = new URLSearchParams();
    if (filters.warehouseId) q.set('warehouseId', filters.warehouseId);
    if (filters.variantId) q.set('variantId', filters.variantId);
    if (filters.movementType) q.set('movementType', filters.movementType);
    q.set('page', String(filters.page ?? 1));
    q.set('limit', String(filters.limit ?? 50));
    return api.get<MovementListResult>(`/inventory/movements?${q.toString()}`);
  },

  /** `inventory.view`. Filters by variant only — there is no warehouse
   *  filter on the lot contract, and none is faked here. */
  lots: (variantId?: string) =>
    api.get<{ data: InventoryLot[] }>(`/inventory/lots${variantId ? `?variantId=${variantId}` : ''}`),

  /** `inventory.view`. Filters by variant and/or status. */
  serials: (params: { variantId?: string; status?: SerialStatus } = {}) => {
    const q = new URLSearchParams();
    if (params.variantId) q.set('variantId', params.variantId);
    if (params.status) q.set('status', params.status);
    const qs = q.toString();
    return api.get<{ data: SerialNumber[] }>(`/inventory/serials${qs ? `?${qs}` : ''}`);
  },

  /** `inventory.view`. Compares each cached balance against the movement
   *  ledger. An integrity check the server performs; the browser only
   *  renders what it found. */
  reconciliation: () => api.get<{ data: ReconciliationResult }>('/inventory/reconciliation'),

  /**
   * `inventory.adjust`. SIGNED quantity — positive found, negative lost —
   * and a reason is REQUIRED by the schema. Posts an accounting entry and
   * writes a stock movement; the browser predicts neither.
   */
  adjust: (body: { warehouseId: string; variantId: string; quantity: number; movementType: AdjustmentType; reason: string }) =>
    api.post<{ data: StockMutationResult }>('/inventory/adjustments', body),

  // ------------------------------------------------------- transfers --
  listTransfers: () => api.get<{ data: StockTransfer[] }>('/inventory/transfers'),
  getTransfer: (id: string) => api.get<{ data: StockTransfer }>(`/inventory/transfers/${id}`),

  /** `inventory.transfer_create`. Creates a DRAFT only — no stock is
   *  reserved or moved, and availability is not yet checked. */
  createTransfer: (body: {
    sourceWarehouseId: string;
    destinationWarehouseId: string;
    items: { variantId: string; quantity: number }[];
  }) => api.post<{ data: StockTransfer }>('/inventory/transfers', body),

  /**
   * `inventory.transfer_send`. THIS is where stock leaves the source and
   * availability is checked, under the engine's lock. A serial-tracked
   * line must name one serial per unit or the send is refused.
   */
  sendTransfer: (id: string, items?: { variantId: string; serials: string[] }[]) =>
    api.post<{ data: StockTransfer }>(`/inventory/transfers/${id}/send`, items ? { items } : {}),

  /**
   * `inventory.transfer_receive`. Anything shipped but not listed here
   * STAYS IN_TRANSIT rather than being quietly absorbed — a short receipt
   * is a real discrepancy and the serial record says so.
   */
  receiveTransfer: (id: string, items: { variantId: string; quantityReceived: number; serials?: string[] }[]) =>
    api.post<{ data: StockTransfer }>(`/inventory/transfers/${id}/receive`, { items }),

  // ----------------------------------------------------- stock counts --
  /** `inventory.stock_count_create`. Omitting `variantIds` snapshots every
   *  variant that currently has a balance row in that warehouse. */
  createCount: (body: { warehouseId: string; variantIds?: string[] }) =>
    api.post<{ data: StockCount }>('/inventory/stock-counts', body),
  getCount: (id: string) => api.get<{ data: StockCount }>(`/inventory/stock-counts/${id}`),
  submitCountItems: (id: string, items: { variantId: string; actualQuantity: number; reason?: string }[]) =>
    api.patch<{ data: StockCount }>(`/inventory/stock-counts/${id}/items`, { items }),
  submitCount: (id: string) => api.post<{ data: StockCount }>(`/inventory/stock-counts/${id}/submit`),
  /** `inventory.stock_count_approve` — a SECOND grant, deliberately. This
   *  is the call that actually moves stock to match the count. */
  approveCount: (id: string) => api.post<{ data: StockCount }>(`/inventory/stock-counts/${id}/approve`),
};
