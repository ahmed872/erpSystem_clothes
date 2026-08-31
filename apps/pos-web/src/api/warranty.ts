import { api } from '../lib/apiClient';
import type { RegisterWarrantyInput, WarrantyClaim, WarrantyDetail, WarrantyListRow } from '../lib/apiTypes';

/**
 * Phase 12 (Warranty) — the Phase 8A/8E contract, unchanged.
 *
 * Note what is NOT here: nothing that evaluates coverage. Eligibility,
 * duration, start/end dates, effective status and claim admissibility are
 * all decided server-side from the warranty's own snapshot, and this app
 * only ever displays the answer. In particular `register` sends no dates
 * and normally no duration — the sale's own timestamp starts the cover and
 * the business default sets its length, so a till cannot invent a period.
 */
export const warrantyApi = {
  /** Existing cover for ONE physical unit. The `serialNumberId` filter is
   * how the POS asks "is this unit already warranted?" without evaluating
   * anything itself. */
  forSerial: (serialNumberId: string) =>
    api.get<{ data: WarrantyListRow[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>(
      `/warranties?serialNumberId=${encodeURIComponent(serialNumberId)}&limit=200`,
    ),
  get: (id: string) => api.get<{ data: WarrantyDetail }>(`/warranties/${id}`),
  register: (input: RegisterWarrantyInput) => api.post<{ data: WarrantyListRow }>('/warranties', input),
  claims: (warrantyId: string) => api.get<{ data: WarrantyClaim[] }>(`/warranties/${warrantyId}/claims`),
  raiseClaim: (warrantyId: string, description: string) =>
    api.post<{ data: WarrantyClaim }>(`/warranties/${warrantyId}/claims`, { description }),
};
