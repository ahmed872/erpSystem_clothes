import { api } from '../lib/apiClient';
import type { ClaimResolution, WarrantyClaim, WarrantyDetail, WarrantyListRow } from '../lib/apiTypes';

/**
 * Phase 13 (ERP slice) — the back-office half of warranty, which the POS
 * deliberately excluded.
 *
 * The till can register cover and LODGE a claim; deciding to repair,
 * replace or reject happens after inspection and belongs here. Both sides
 * call the same `warranty.claim`-gated endpoint — the boundary is a
 * product decision about where the screen lives, never a second contract.
 */
export const warrantyApi = {
  /** Warranties, optionally narrowed to those with a claim against them. */
  list: (params: { status?: string; customerId?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.customerId) q.set('customerId', params.customerId);
    q.set('limit', String(params.limit ?? 100));
    return api.get<{
      data: WarrantyListRow[];
      pagination: { page: number; limit: number; total: number; totalPages: number };
    }>(`/warranties?${q.toString()}`);
  },
  /** One warranty WITH its full claim history — the detail the resolver reads. */
  get: (id: string) => api.get<{ data: WarrantyDetail }>(`/warranties/${id}`),
  claims: (warrantyId: string) => api.get<{ data: WarrantyClaim[] }>(`/warranties/${warrantyId}/claims`),
  /**
   * The one-way transition OPEN → RESOLVED | REJECTED. The server refuses
   * a claim that is not OPEN and refuses a concurrent second resolution,
   * so this screen offers the control and the server decides the outcome.
   */
  resolveClaim: (warrantyId: string, claimId: string, input: { status: ClaimResolution; resolution?: string }) =>
    api.post<{ data: WarrantyClaim }>(`/warranties/${warrantyId}/claims/${claimId}/resolve`, input),
};
