import { api } from '../lib/apiClient';
import type { LoginResult } from '../lib/apiTypes';

export interface LoginInput {
  email: string;
  password: string;
  businessSlug: string;
}

export const authApi = {
  login: (input: LoginInput) => api.post<{ data: LoginResult }>('/auth/login', input),
  logout: (refreshToken: string) => api.post<void>('/auth/logout', { refreshToken }),
};
