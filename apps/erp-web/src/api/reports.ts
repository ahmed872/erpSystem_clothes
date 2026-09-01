import { api } from '../lib/apiClient';
import type { DashboardResult } from '../lib/apiTypes';

export const reportsApi = {
  /**
   * `GET /reports/dashboard`, gated on `reports.dashboard.view`.
   *
   * Every figure is computed server-side from the ledger and the sale
   * records; the browser adds nothing. `branchId` is a FILTER the server
   * then validates against the caller's own branch scope — passing one the
   * caller is not entitled to is a 403, never a silent empty result.
   */
  dashboard: (params: { from?: string; to?: string; branchId?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.from) q.set('from', params.from);
    if (params.to) q.set('to', params.to);
    if (params.branchId) q.set('branchId', params.branchId);
    const qs = q.toString();
    return api.get<DashboardResult>(`/reports/dashboard${qs ? `?${qs}` : ''}`);
  },
};
