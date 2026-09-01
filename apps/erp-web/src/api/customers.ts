import { api } from '../lib/apiClient';
import type {
  AdjustPointsInput,
  CustomerDetail,
  CustomerFilters,
  CustomerInput,
  CustomerListResult,
  CustomerPointsBalance,
  CustomerPointsLedger,
  CustomerPointsType,
  CustomerRow,
} from '../lib/apiTypes';

/**
 * Phase 18 — customers, consumed exactly as the live backend defines
 * them. NOT ONE ENDPOINT WAS ADDED: `sales/customers` and the loyalty
 * routes hanging off it all predate this milestone and are shared with
 * the POS, which searches, selects and creates customers through the same
 * contracts.
 *
 * THREE GRANTS, THREE SURFACES, KEPT SEPARATE. Reading a customer is
 * `customers.view`; their loyalty is `loyalty.view`; their sales history
 * is `sales.view`. A caller may hold any one without the others, so the
 * detail screen requests each independently and renders only what came
 * back — rather than one composite call that would 403 as a whole.
 *
 * NOTHING FINANCIAL IS COMPUTED HERE. `balance` is
 * `SUM(CustomerTransaction.amount)` and the points balance is
 * `SUM(CustomerPoints.points)`, both derived by the server on every read.
 */
export const customersApi = {
  /**
   * `customers.view`. The live query accepts `search`, `isActive`, `page`
   * and `limit` — nothing else. `search` covers name OR phone with
   * `contains` semantics, and the SERVER ranks an exact phone match
   * first, in SQL, before the page is cut; re-sorting the fetched page
   * here would strand an exact match on page three.
   */
  list: (filters: CustomerFilters = {}) => {
    const q = new URLSearchParams();
    if (filters.search) q.set('search', filters.search);
    if (filters.isActive !== undefined) q.set('isActive', String(filters.isActive));
    q.set('page', String(filters.page ?? 1));
    q.set('limit', String(filters.limit ?? 50));
    return api.get<CustomerListResult>(`/sales/customers?${q.toString()}`);
  },

  /** `customers.view`. Adds the server balance and the last 100 ledger
   *  rows; there is no paging over those. */
  get: (id: string) => api.get<{ data: CustomerDetail }>(`/sales/customers/${id}`),

  /** `customers.create`. The five fields the schema accepts. */
  create: (input: CustomerInput) => api.post<{ data: CustomerRow }>('/sales/customers', input),

  /** `customers.edit`. The same five fields, all optional. `isActive` is
   *  NOT among them and is silently dropped if sent. */
  update: (id: string, input: Partial<CustomerInput>) => api.patch<{ data: CustomerRow }>(`/sales/customers/${id}`, input),

  /** `customers.delete`. A SOFT delete: it sets `isActive` false and
   *  409s if the customer is already inactive. There is no hard delete —
   *  `erp_app` holds no DELETE grant on the table at all, because every
   *  Sale and CustomerTransaction ever raised still references the row. */
  deactivate: (id: string) => api.delete<{ data: CustomerRow }>(`/sales/customers/${id}`),

  /** `loyalty.view`. */
  points: (id: string) => api.get<{ data: CustomerPointsBalance }>(`/sales/customers/${id}/points`),

  /** `loyalty.view`. Append-only history, newest first. */
  pointsLedger: (id: string, opts: { type?: CustomerPointsType; page?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.type) q.set('type', opts.type);
    q.set('page', String(opts.page ?? 1));
    q.set('limit', String(opts.limit ?? 20));
    return api.get<CustomerPointsLedger>(`/sales/customers/${id}/points/ledger?${q.toString()}`);
  },

  /** `loyalty.adjust`. The one human-entered write to the points ledger,
   *  carrying its own idempotency key. */
  adjustPoints: (id: string, input: AdjustPointsInput) =>
    api.post<{ data: unknown }>(`/sales/customers/${id}/points/adjust`, input),
};
