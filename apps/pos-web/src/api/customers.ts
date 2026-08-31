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
};
