import { api } from '../lib/apiClient';
import type {
  CreateSaleInput,
  CreateSaleReturnInput,
  QuoteSaleInput,
  Sale,
  SaleListRow,
  SaleQuote,
  SaleReceipt,
  SaleReturn,
} from '../lib/apiTypes';

export const salesApi = {
  create: (input: CreateSaleInput) => api.post<{ data: Sale }>('/sales', input),
  /**
   * Phase 12: the authoritative total for a cart, before any money is
   * taken. Priced by the SAME server pipeline the sale runs, inside a
   * read-only transaction, so it creates nothing and reserves nothing.
   * `totals.amountDue` is what `create` must be tendered.
   */
  quote: (input: QuoteSaleInput) => api.post<{ data: SaleQuote }>('/sales/quote', input),
  get: (id: string) => api.get<{ data: Sale }>(`/sales/${id}`),
  receipt: (id: string) => api.get<{ data: SaleReceipt }>(`/sales/${id}/receipt`),
  /** There is no sale-search-by-number endpoint (deliberately out of Phase
   * 12 scope, see docs/state/PROJECT_STATE.md's recorded gaps) — a cashier
   * picks a return's source sale from THIS SHIFT's own transaction list,
   * which the existing `GET /sales?shiftId=` contract already supports. */
  listByShift: (shiftId: string) =>
    api.get<{ data: SaleListRow[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>(
      `/sales?shiftId=${shiftId}&limit=100`,
    ),
  createReturn: (saleId: string, input: CreateSaleReturnInput) =>
    api.post<{ data: SaleReturn }>(`/sales/${saleId}/returns`, input),
};
