import { api } from '../lib/apiClient';
import type {
  CreateSaleInput,
  CreateSaleReturnInput,
  PreviewSaleReturnInput,
  QuoteSaleInput,
  Sale,
  SaleListRow,
  SaleQuote,
  SaleReceipt,
  SaleReturn,
  SaleReturnPreview,
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
  /**
   * Phase 12 (Returns): find the sale on the receipt in the customer's
   * hand, whichever shift produced it. Exact, index-backed equality
   * against `@@unique([businessId, saleNumber])`; the server upper-cases
   * the input, so a cashier may type it however they read it.
   */
  findByNumber: (saleNumber: string) =>
    api.get<{ data: SaleListRow[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>(
      `/sales?saleNumber=${encodeURIComponent(saleNumber)}`,
    ),
  /**
   * Phase 12 (Returns): what this return is worth, before it happens.
   * Read-only on the server; creates nothing and reserves nothing.
   * `refund.requiredAmount` is the exact figure a walk-in must be handed.
   */
  previewReturn: (saleId: string, input: PreviewSaleReturnInput) =>
    api.post<{ data: SaleReturnPreview }>(`/sales/${saleId}/returns/preview`, input),
  listByShift: (shiftId: string) =>
    api.get<{ data: SaleListRow[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>(
      `/sales?shiftId=${shiftId}&limit=100`,
    ),
  createReturn: (saleId: string, input: CreateSaleReturnInput) =>
    api.post<{ data: SaleReturn }>(`/sales/${saleId}/returns`, input),
};
