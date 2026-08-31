import { api } from '../lib/apiClient';
import type { MyPermissionsResult } from '../lib/apiTypes';

export const permissionsApi = {
  /** Phase 12 BLOCKING-A: the caller's own effective permission set. Used
   * for navigation/UX only — see store/authStore.ts. */
  getMine: () => api.get<{ data: MyPermissionsResult }>('/permissions/me'),
};
