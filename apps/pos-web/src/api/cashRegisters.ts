import { api } from '../lib/apiClient';
import type { CashRegister } from '../lib/apiTypes';

export const cashRegistersApi = {
  list: (branchId: string) => api.get<{ data: CashRegister[] }>(`/cash-registers?branchId=${encodeURIComponent(branchId)}`),
};
