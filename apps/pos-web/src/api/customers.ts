import { api } from '../lib/apiClient';
import type { Customer, Paginated } from '../lib/apiTypes';

export interface CreateCustomerInput {
  name: string;
  phone?: string;
  email?: string;
}

export const customersApi = {
  search: (search: string) => api.get<Paginated<Customer>>(`/sales/customers?search=${encodeURIComponent(search)}&isActive=true`),
  create: (input: CreateCustomerInput) => api.post<{ data: Customer }>('/sales/customers', input),
  /** Phase 12 (Held Sales): a hold stores `customerId` alone, so picking a
   * basket up re-reads the customer from the server rather than showing a
   * name remembered from whenever it was parked. */
  get: (id: string) => api.get<{ data: Customer }>(`/sales/customers/${id}`),
};
