import { api } from '../lib/apiClient';
import type {
  CreateHeldSaleInput,
  HeldSale,
  HeldSaleList,
  HeldSaleStatus,
  ResumeHeldSaleInput,
  ResumeHeldSaleResult,
  UpdateHeldSaleInput,
} from '../lib/apiTypes';

/**
 * Phase 12 (Held Sales) — the parked-basket contract, unchanged from
 * Phase 10.
 *
 * `resume` is the ONLY way this app turns a hold into a sale. It is not
 * `POST /sales` with the hold's lines copied in: that would create the sale
 * and leave the basket sitting there OPEN for someone else to sell a second
 * time. The server claims the hold and creates the sale in ONE transaction,
 * which is what makes two cashiers pressing the button at once produce
 * exactly one sale.
 */
export const holdsApi = {
  list: (status: HeldSaleStatus = 'OPEN', warehouseId?: string) =>
    api.get<HeldSaleList>(
      `/sales/holds?status=${status}&limit=200${warehouseId ? `&warehouseId=${warehouseId}` : ''}`,
    ),
  get: (id: string) => api.get<{ data: HeldSale }>(`/sales/holds/${id}`),
  create: (input: CreateHeldSaleInput) => api.post<{ data: HeldSale }>('/sales/holds', input),
  /** Replaces the parked lines wholesale — the server releases the old
   * advisory reservation before claiming the new one. */
  update: (id: string, input: UpdateHeldSaleInput) => api.patch<{ data: HeldSale }>(`/sales/holds/${id}`, input),
  resume: (id: string, input: ResumeHeldSaleInput) =>
    api.post<{ data: ResumeHeldSaleResult }>(`/sales/holds/${id}/resume`, input),
  /** Abandoning a basket. Never a delete: a basket parked and walked away
   * from is a real thing that happened at that till. */
  void: (id: string, reason?: string) => api.post<{ data: HeldSale }>(`/sales/holds/${id}/void`, { reason }),
};
