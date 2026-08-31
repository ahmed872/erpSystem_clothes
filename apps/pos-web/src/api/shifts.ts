import { api } from '../lib/apiClient';
import type { PosWarehouseOption, Shift, CashTransaction } from '../lib/apiTypes';

export interface OpenShiftInput {
  warehouseId: string;
  cashRegisterId: string;
  openingFloat: number;
}

export interface CloseShiftInput {
  countedCash: number;
  notes?: string;
}

export const shiftsApi = {
  /** Phase 12 BLOCKING-B: POS-safe warehouse discovery. Throws (422) when
   * nothing is authorized — never falls back to an unrelated warehouse. */
  availableWarehouses: () => api.get<{ data: PosWarehouseOption[] }>('/sales/shifts/available-warehouses'),
  active: () => api.get<{ data: Shift | null }>('/sales/shifts/active'),
  open: (input: OpenShiftInput) => api.post<{ data: Shift }>('/sales/shifts/open', input),
  close: (input: CloseShiftInput) => api.post<{ data: Shift }>('/sales/shifts/close', input),
  cashTransactions: (shiftId: string) => api.get<{ data: CashTransaction[] }>(`/sales/shifts/${shiftId}/cash-transactions`),
  recordCashMovement: (shiftId: string, input: { type: 'PAY_IN' | 'PAY_OUT'; amount: number; reason: string }) =>
    api.post<{ data: CashTransaction }>(`/sales/shifts/${shiftId}/cash-transactions`, input),
};
