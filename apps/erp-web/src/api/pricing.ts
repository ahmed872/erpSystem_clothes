import { api } from '../lib/apiClient';
import type { PriceList, PriceListEntry } from '../lib/apiTypes';

/**
 * Phase 14 — PRICE LISTS: THE DATA THE BACKEND'S PRICING AUTHORITY READS.
 *
 * There is NO pricing engine here, and there must never be one. The ERP
 * writes configuration; `resolveSellingPrice` on the server decides what a
 * line is actually sold at, and `POST /sales` persists the price the
 * PIPELINE resolved rather than the one any browser proposed. This module
 * is CRUD over that configuration and nothing more — it computes no
 * applicable price, applies no rule, and duplicates none of D3's logic.
 *
 * WHAT APPLICABILITY MEANS TODAY, exactly and only: `PriceList.isDefault`
 * together with `isActive`. The live schema carries no customer-, branch-
 * or warehouse-scoped price list, and nothing here invents one.
 */
export const pricingApi = {
  /** `pricelists.view` */
  list: () => api.get<{ data: PriceList[] }>('/catalog/price-lists'),

  /** `pricelists.create`. Setting `isDefault` demotes the previous default
   *  server-side — the tenant is held to at most one. */
  create: (body: { name: string; isDefault?: boolean }) =>
    api.post<{ data: PriceList }>('/catalog/price-lists', body),

  /** `pricelists.edit` — rename, promote to default, activate/deactivate. */
  update: (id: string, body: { name?: string; isDefault?: boolean; isActive?: boolean }) =>
    api.patch<{ data: PriceList }>(`/catalog/price-lists/${id}`, body),

  /** `pricelists.view` */
  listEntries: (id: string) => api.get<{ data: PriceListEntry[] }>(`/catalog/price-lists/${id}/prices`),

  /** `pricelists.manage_prices` — its OWN grant, separate from `edit`, so
   *  a user may rename a list without being able to reprice the shop.
   *  Upsert by (priceList, variant); writes a ProductPriceHistory row. */
  upsertEntry: (id: string, variantId: string, price: number) =>
    api.put<{ data: PriceListEntry }>(`/catalog/price-lists/${id}/prices`, { variantId, price }),
};
