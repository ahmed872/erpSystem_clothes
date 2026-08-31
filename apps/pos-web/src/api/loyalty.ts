import { api } from '../lib/apiClient';
import type { CustomerPointsBalance } from '../lib/apiTypes';

export const loyaltyApi = {
  balance: (customerId: string) => api.get<{ data: CustomerPointsBalance }>(`/sales/customers/${customerId}/points`),
};
