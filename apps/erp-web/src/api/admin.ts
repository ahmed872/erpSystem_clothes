import { api } from '../lib/apiClient';
import type {
  AdminUser,
  AdminUserSummary,
  AuditLogFilters,
  AuditLogListResult,
  Branch,
  BusinessProfile,
  PasswordResetResult,
  PermissionCatalogEntry,
  Role,
  TaxSettings,
  UserStatus,
  Warehouse,
} from '../lib/apiTypes';

/**
 * Phase 20 — ADMINISTRATION, against the contracts that already exist.
 *
 * NOTHING HERE IS INVENTED. Every path, verb, field and filter below was
 * read off the live controllers; where a screen would have liked something
 * the backend does not offer, the screen goes without rather than the
 * client guessing:
 *
 *   - `GET /users` takes NO search, filter or page parameters. The users
 *     screen narrows the list it received, and says so.
 *   - There is no `GET /users/:id`, so there is no user-detail route.
 *   - There is no DELETE for a branch or a warehouse. Both deactivate
 *     through their PATCH, which is why the screens say "Deactivate".
 *   - `DELETE /users/:id` is a SUSPENSION, not a deletion — the server
 *     turns it into `status: SUSPENDED` — so it is named for what it does.
 *   - `/audit-logs` returns `{ data, meta }` at the top level, not the
 *     `{ data: ... }` envelope every other endpoint uses.
 */

export const adminApi = {
  // ------------------------------------------------------------- users --
  /** `users.view`. Unpaged and unfiltered by contract. */
  listUsers: () => api.get<{ data: AdminUser[] }>('/users'),
  /** `users.create`. `branchIds` may be empty: an empty scope means every
   *  branch, subject to permissions, which is the model's own rule. */
  createUser: (body: { name: string; email: string; password: string; roleIds: string[]; branchIds: string[] }) =>
    api.post<{ data: AdminUserSummary }>('/users', body),
  /** `users.edit`. Every field optional; omitting one leaves it alone. */
  updateUser: (
    id: string,
    body: { name?: string; roleIds?: string[]; branchIds?: string[]; status?: UserStatus },
  ) => api.patch<{ data: AdminUserSummary }>(`/users/${id}`, body),
  /** `users.delete` — a SUSPENSION. The row is never removed; the server
   *  performs `status: SUSPENDED` and the last-owner guard still applies. */
  suspendUser: (id: string) => api.delete<{ data: AdminUserSummary }>(`/users/${id}`),
  /** `users.edit`. Revokes every live session of that user, including on
   *  the device they are reading this on — the server returns how many. */
  resetUserPassword: (id: string, newPassword: string) =>
    api.post<{ data: PasswordResetResult }>(`/users/${id}/password`, { newPassword }),

  // ------------------------------------------------------------- roles --
  listRoles: () => api.get<{ data: Role[] }>('/roles'),
  createRole: (body: { name: string; permissionCodes: string[] }) => api.post<{ data: Role }>('/roles', body),
  /** `roles.edit`. The server refuses a rename of a system role and any
   *  change that would strip role administration from a role the caller
   *  holds (Decision B) — this client predicts neither, it only asks. */
  updateRole: (id: string, body: { name?: string; permissionCodes?: string[] }) =>
    api.patch<{ data: Role }>(`/roles/${id}`, body),
  /** `roles.delete`. Refused for a system template, and for any role still
   *  assigned to a user. */
  deleteRole: (id: string) => api.delete<{ data: null }>(`/roles/${id}`),

  /** `permissions.view` — the GLOBAL catalogue, the vocabulary a role is
   *  built from. Separate from `GET /permissions/me`, which is the
   *  caller's own effective set and needs no grant. */
  listPermissionCatalog: () => api.get<{ data: PermissionCatalogEntry[] }>('/permissions'),

  // ------------------------------------------------------ organisation --
  listBranches: () => api.get<{ data: Branch[] }>('/branches'),
  createBranch: (body: { name: string; address?: string; phone?: string }) =>
    api.post<{ data: Branch }>('/branches', body),
  updateBranch: (id: string, body: { name?: string; address?: string; phone?: string; isActive?: boolean }) =>
    api.patch<{ data: Branch }>(`/branches/${id}`, body),

  listWarehouses: (branchId?: string) =>
    api.get<{ data: Warehouse[] }>(`/warehouses${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`),
  createWarehouse: (body: { branchId: string; name: string; isDefault?: boolean }) =>
    api.post<{ data: Warehouse }>('/warehouses', body),
  updateWarehouse: (id: string, body: { name?: string; isDefault?: boolean; isActive?: boolean }) =>
    api.patch<{ data: Warehouse }>(`/warehouses/${id}`, body),

  // -------------------------------------------------- business profile --
  getBusiness: () => api.get<{ data: BusinessProfile }>('/business'),
  /** `business.edit`. A profile field sent as `null` CLEARS it; omitting
   *  it leaves it alone. That distinction is the contract's, and the form
   *  preserves it rather than flattening both to an empty string. */
  updateBusiness: (body: Record<string, string | null>) => api.patch<{ data: BusinessProfile }>('/business', body),

  // ------------------------------------------------------ tax settings --
  /** `tax.view` / `tax.manage`. Two fields only; the rate table itself is
   *  edited on the setup screen, and every computed amount stays the
   *  server's. */
  getTaxSettings: () => api.get<{ data: TaxSettings }>('/settings/tax'),
  updateTaxSettings: (body: { taxPricingMode?: 'EXCLUSIVE' | 'INCLUSIVE'; defaultTaxId?: string | null }) =>
    api.put<{ data: TaxSettings }>('/settings/tax', body),

  // --------------------------------------------------------- audit log --
  /** `audit.view`. Read-only by construction: the database grants the API
   *  role SELECT and INSERT on `audit_logs` and nothing else, so no edit
   *  endpoint could exist to call. */
  listAuditLogs: (filters: AuditLogFilters) => api.get<AuditLogListResult>(`/audit-logs${auditQuery(filters)}`),
};

/** Only the filters that are actually set are sent: the backend's zod
 *  schema rejects an empty string where it expects a uuid or an enum. */
export function auditQuery(filters: AuditLogFilters): string {
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  };
  set('userId', filters.userId);
  set('action', filters.action);
  set('entityType', filters.entityType);
  set('entityId', filters.entityId);
  set('requestId', filters.requestId);
  set('from', filters.from);
  set('to', filters.to);
  set('page', filters.page);
  set('limit', filters.limit);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
