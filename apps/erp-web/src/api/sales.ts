import { api } from '../lib/apiClient';
import type {
  SaleCustomer,
  SaleDetail,
  SaleFilters,
  SaleListResult,
  SalePaymentMethod,
  SaleReceipt,
} from '../lib/apiTypes';

/**
 * Phase 17 — sales, consumed exactly as the live backend defines them.
 *
 * NOT ONE ENDPOINT WAS ADDED. The list, the detail, the receipt and the
 * payment path all existed; the ERP reads them and settles an invoice,
 * and does nothing else.
 *
 * WHAT THE ERP DELIBERATELY DOES NOT CALL. `POST /sales`,
 * `POST /sales/quote`, the returns endpoints and the exchange endpoints
 * are the POS's selling workflow. The back office INSPECTS those
 * documents — a sale's returns arrive on its detail, an exchange arrives
 * as `exchangeForReturn` — but it does not perform them. Duplicating the
 * checkout here would be a second selling surface with a second set of
 * bugs.
 *
 * NO SALE ARITHMETIC HAPPENS IN THIS APP. Totals, tax, discounts,
 * promotions, loyalty and the payment summary are all the server's, most
 * of them frozen on the document at the moment of sale.
 */
export const salesApi = {
  /**
   * `sales.view`. The five filters the contract actually accepts.
   * `saleNumber` is an EXACT, index-backed lookup, not a search — the
   * receipt in someone's hand, not a pattern.
   */
  list: (filters: SaleFilters = {}) => {
    const q = new URLSearchParams();
    if (filters.saleNumber) q.set('saleNumber', filters.saleNumber);
    if (filters.customerId) q.set('customerId', filters.customerId);
    if (filters.warehouseId) q.set('warehouseId', filters.warehouseId);
    if (filters.branchId) q.set('branchId', filters.branchId);
    if (filters.shiftId) q.set('shiftId', filters.shiftId);
    q.set('page', String(filters.page ?? 1));
    q.set('limit', String(filters.limit ?? 50));
    return api.get<SaleListResult>(`/sales?${q.toString()}`);
  },

  /**
   * `sales.view`. The ONLY place the payment summary lives — the list
   * does not carry it — and the only place cost and profit appear, for a
   * holder of `products.view_cost`.
   */
  get: (id: string) => api.get<{ data: SaleDetail }>(`/sales/${id}`),

  /** `sales.view`. The frozen receipt contract, reprinted from what the
   *  sale STORED: reprinting a six-month-old sale shows the figures it
   *  showed then, whatever has changed since. */
  receipt: (id: string) => api.get<{ data: SaleReceipt }>(`/sales/${id}/receipt`),

  /**
   * `sales.pay` — settling an invoice that was not paid in full at the
   * till. Its own grant, held by the ACCOUNTANT and the BRANCH_MANAGER
   * but not, for instance, by a stock role.
   *
   * `idempotencyKey` is part of the live contract and is generated once
   * per dialog, so a double submit records one payment rather than two.
   */
  pay: (id: string, body: { amount: number; method: SalePaymentMethod; reference?: string; idempotencyKey?: string }) =>
    api.post<{ data: unknown }>(`/sales/${id}/payments`, body),

  /** `customers.view` — the customer context a sale points at. */
  listCustomers: (search?: string) => {
    const q = new URLSearchParams();
    if (search) q.set('search', search);
    q.set('limit', '100');
    return api.get<{ data: SaleCustomer[] }>(`/sales/customers?${q.toString()}`);
  },
};
