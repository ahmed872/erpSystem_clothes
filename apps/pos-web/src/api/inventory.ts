import { api } from '../lib/apiClient';
import type { StockBalance } from '../lib/apiTypes';

export const inventoryApi = {
  /** UX preview only — the create-sale call re-validates stock server-side
   * and is authoritative; this is what lets the cashier see "3 available"
   * before scanning. */
  balanceFor: (warehouseId: string, variantId: string) =>
    api.get<{ data: StockBalance[] }>(`/inventory/balances?warehouseId=${warehouseId}&variantId=${variantId}`),
};
