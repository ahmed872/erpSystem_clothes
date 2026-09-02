import { api } from '../lib/apiClient';
import type {
  AdminBranch,
  AdminRole,
  AdminUser,
  AdminWarehouse,
  AuditFilters,
  AuditLogResult,
  BranchInput,
  BusinessInput,
  BusinessProfile,
  CreateUserInput,
  CreateWarehouseInput,
  PermissionCatalogEntry,
  RoleInput,
  UpdateUserInput,
  UpdateWarehouseInput,
} from '../lib/apiTypes';

/**
 * Phase 20 — administration, consumed exactly as the live backend
 * defines it. NOT ONE ENDPOINT WAS ADDED.
 *
 * WHAT THE CONTRACT DOES NOT OFFER, and is therefore not offered here:
 *   - no `GET /users/:id`, and no list filters or paging on `GET /users`
 *   - no DELETE for a branch or a warehouse
 *   - no mutation of the permission catalog, which is global and
 *     read-only
 *   - no useful key/value settings store (it is empty by default and
 *     accepts arbitrary keys, so this app never writes to it)
 *
 * ROLES AND BRANCHES ARE REPLACEMENT ARRAYS on a user, and permission
 * codes are a replacement array on a role. Sending a partial list
 * REMOVES what is missing — every caller below builds the whole list.
 */
export const adminApi = {
  // ------------------------------------------------------------ users --
  /** `users.view`. No filters exist; the list is the whole tenant. */
  listUsers: () => api.get<{ data: AdminUser[] }>('/users'),

  /** `users.create`. The password is write-only and never comes back. */
  createUser: (input: CreateUserInput) => api.post<{ data: AdminUser }>('/users', input),

  /** `users.edit`. Also the suspend/reactivate path, via `status`. */
  updateUser: (id: string, input: UpdateUserInput) => api.patch<{ data: AdminUser }>(`/users/${id}`, input),

  /** `users.delete` — a SOFT suspend, identical to `PATCH { status:
   *  'SUSPENDED' }`. Refused for the last active Business Owner. */
  suspendUser: (id: string) => api.delete<{ data: AdminUser }>(`/users/${id}`),

  /**
   * `users.edit`. An administrator sets a new password for someone who
   * forgot theirs — the case that actually happens in a shop. It revokes
   * every REFRESH token that user holds, so they are signed out of every
   * device once their current access token expires.
   */
  resetPassword: (id: string, newPassword: string) =>
    api.post<{ data: { revokedSessions: number } }>(`/users/${id}/password`, { newPassword }),

  // ------------------------------------------------------------ roles --
  /** `roles.view`. Carries `isSystem` and the full permission set. */
  listRoles: () => api.get<{ data: AdminRole[] }>('/roles'),

  /** `roles.create`. Always a custom role — `isSystem` is server-set. */
  createRole: (input: { name: string; permissionCodes: string[] }) => api.post<{ data: AdminRole }>('/roles', input),

  /**
   * `roles.edit`. The server refuses two things here, and the UI states
   * both rather than discovering them as errors: a built-in template
   * cannot be RENAMED, and no edit may leave the CALLER without
   * `roles.view` or `roles.edit`.
   */
  updateRole: (id: string, input: RoleInput) => api.patch<{ data: AdminRole }>(`/roles/${id}`, input),

  /** `roles.delete`. A HARD delete, refused for a built-in template or a
   *  role still assigned to anyone. */
  deleteRole: (id: string) => api.delete<{ data: null }>(`/roles/${id}`),

  /**
   * `permissions.view`. THE canonical catalog — 117 global, immutable
   * codes. Fetched, never hardcoded: a permission list duplicated in the
   * browser would drift from the one the server authorizes against.
   */
  listPermissions: () => api.get<{ data: PermissionCatalogEntry[] }>('/permissions'),

  // --------------------------------------------------------- branches --
  /** `branches.view`. Returns ACTIVE AND INACTIVE branches; the
   *  `isActive` query parameter is accepted and ignored by the server,
   *  so this client does not send one and the screen filters nothing. */
  listBranches: () => api.get<{ data: AdminBranch[] }>('/branches'),

  /** `branches.create`. */
  createBranch: (input: { name: string; address?: string; phone?: string }) =>
    api.post<{ data: AdminBranch }>('/branches', input),

  /** `branches.edit`. Also the only deactivation path — there is no
   *  DELETE route for a branch at all. */
  updateBranch: (id: string, input: BranchInput) => api.patch<{ data: AdminBranch }>(`/branches/${id}`, input),

  // ------------------------------------------------------- warehouses --
  /** `warehouses.view`. */
  listWarehouses: () => api.get<{ data: AdminWarehouse[] }>('/warehouses'),

  /** `warehouses.create`. Names are unique per branch. */
  createWarehouse: (input: CreateWarehouseInput) => api.post<{ data: AdminWarehouse }>('/warehouses', input),

  /** `warehouses.edit`. Also the only deactivation path. Setting
   *  `isDefault` clears the previous default OF THE SAME BRANCH,
   *  server-side — the browser does not manage that. */
  updateWarehouse: (id: string, input: UpdateWarehouseInput) =>
    api.patch<{ data: AdminWarehouse }>(`/warehouses/${id}`, input),

  // --------------------------------------------------------- business --
  /** `business.view`. */
  getBusiness: () => api.get<{ data: BusinessProfile }>('/business'),

  /** `business.edit`. Exactly the 14 fields the schema accepts — `slug`
   *  and `status` are read-only and are never sent. */
  updateBusiness: (input: BusinessInput) => api.patch<{ data: BusinessProfile }>('/business', input),

  // ------------------------------------------------------------ audit --
  /** `audit.view`. The one endpoint whose envelope is `meta`, not
   *  `pagination` — it predates that convention. */
  listAuditLogs: (filters: AuditFilters = {}) => {
    const q = new URLSearchParams();
    if (filters.userId) q.set('userId', filters.userId);
    if (filters.action) q.set('action', filters.action);
    if (filters.entityType) q.set('entityType', filters.entityType);
    if (filters.entityId) q.set('entityId', filters.entityId);
    if (filters.requestId) q.set('requestId', filters.requestId);
    if (filters.from) q.set('from', filters.from);
    if (filters.to) q.set('to', filters.to);
    q.set('page', String(filters.page ?? 1));
    q.set('limit', String(filters.limit ?? 25));
    return api.get<AuditLogResult>(`/audit-logs?${q.toString()}`);
  },
};
