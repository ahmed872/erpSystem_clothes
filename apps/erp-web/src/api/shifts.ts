import { api } from '../lib/apiClient';
import type { CashRegister, Shift } from '../lib/apiTypes';

/**
 * Phase 13 (ERP slice) — shift review and reconciliation.
 *
 * `GET /sales/shifts` returns the business's shifts newest-first, each
 * carrying its cash position. For a caller WITHOUT `shifts.view_expected`
 * the expected figure, the variance and the in/out totals are REMOVED from
 * every row — the same blind-close guarantee the POS relies on, enforced
 * on this endpoint too.
 *
 * NOTHING HERE COMPUTES CASH. Expected cash is
 * `openingFloat + SUM(cash_transactions.amount)`, derived server-side; the
 * variance is `countedCash - expectedCash`, also server-side. The ERP
 * displays both and adds up nothing.
 */
export const shiftsApi = {
  list: () => api.get<{ data: Shift[] }>('/sales/shifts'),
  cashTransactions: (shiftId: string) =>
    api.get<{ data: { id: string; type: string; amount: string; reason: string | null; createdAt: string }[] }>(
      `/sales/shifts/${shiftId}/cash-transactions`,
    ),
  /**
   * The manager's ACKNOWLEDGEMENT of a closed shift. It records who
   * accepted the variance and when; it cannot alter the cashier's counted
   * amount and posts nothing — the variance already reached the ledger at
   * close. A shift may be reconciled once.
   */
  reconcile: (shiftId: string, note?: string) =>
    api.post<{ data: Shift }>(`/sales/shifts/${shiftId}/reconcile`, { note }),
  registers: () => api.get<{ data: CashRegister[] }>('/cash-registers'),
};
