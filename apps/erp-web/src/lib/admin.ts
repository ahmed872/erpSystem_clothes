import type {
  AdminBranch,
  AdminRole,
  AdminUser,
  AdminWarehouse,
  AuditAction,
  AuditLogRow,
  PermissionCatalogEntry,
} from './apiTypes';

/**
 * Phase 20 — the only administration logic in the ERP browser, and none
 * of it authorizes anything.
 *
 * EVERY GUARD HERE IS VISIBILITY ONLY. The backend re-checks every call,
 * recomputes effective permissions from the database on each request, and
 * enforces the two guards that matter (self-lockout and system-role
 * rename) itself. Hiding a control stops a pointless 409; it grants and
 * withholds nothing.
 *
 * NO ROLE NAMES ARE USED FOR AUTHORIZATION anywhere in this module or the
 * screens that consume it. `isSystemRole` reads the server's `isSystem`
 * FLAG, which is a property of the row, not a name comparison.
 */

/**
 * A CONTRACT LIMITATION, STATED ONCE HERE RATHER THAN GUESSED AT PER
 * SCREEN. `GET /users` accepts no search, filter or pagination
 * parameters, and there is no `GET /users/:id` at all — the list is the
 * only user shape the contract offers. So the users screen shows the
 * whole tenant, filters nothing server-side, and has no detail route.
 */
export const USERS_LIST_HAS_NO_FILTERS = true;

/**
 * There is no DELETE route for a branch or a warehouse. Deactivation is
 * `PATCH { isActive: false }`, and it is reversible — unlike a customer,
 * which Phase 18 found could not be reactivated at all.
 */
export const ORGANISATION_HAS_NO_DELETE = true;

/**
 * The permission catalog is GLOBAL and read-only: no create, update or
 * delete route exists, and the table carries no `business_id`, so it has
 * no RLS policy either. The roles screen fetches it and never ships a
 * copy of its own — a duplicated list would drift from the one the
 * server authorizes against.
 */
export const PERMISSION_CATALOG_IS_READ_ONLY = true;

/**
 * The two grants a caller may never remove from themselves, enforced
 * SERVER-SIDE by `UpdateRoleUseCase` (Phase 20, owner decision B).
 * Mirrored here so the roles screen can WARN before submitting rather
 * than let a well-meant edit come back as a 409 — the warning is a
 * courtesy, the refusal is the server's.
 */
export const SELF_ADMINISTRATION_CODES = ['roles.view', 'roles.edit'] as const;

export function isSystemRole(role: Pick<AdminRole, 'isSystem'>): boolean {
  return role.isSystem;
}

/** A built-in template's NAME is fixed; its permission set is not. */
export function canRenameRole(role: Pick<AdminRole, 'isSystem'>): boolean {
  return !role.isSystem;
}

/** A role is deletable only when it is neither a template nor in use.
 *  The server refuses both with a 409; this just stops the pointless
 *  round trip. */
export function canDeleteRole(role: Pick<AdminRole, 'id' | 'isSystem'>, users: Pick<AdminUser, 'userRoles'>[]): boolean {
  if (role.isSystem) return false;
  return !users.some((u) => u.userRoles.some((ur) => ur.role.id === role.id));
}

export function roleAssignmentCount(role: Pick<AdminRole, 'id'>, users: Pick<AdminUser, 'userRoles'>[]): number {
  return users.filter((u) => u.userRoles.some((ur) => ur.role.id === role.id)).length;
}

export function permissionCodesOf(role: Pick<AdminRole, 'rolePermissions'>): string[] {
  return role.rolePermissions.map((rp) => rp.permission.code);
}

/**
 * Would this proposed permission set cost the CALLER their own
 * administration? Computed exactly as the server computes it: the union
 * over every role the caller holds, with this role's set replaced. A
 * caller who does not hold the role is unaffected.
 *
 * The browser's copy exists to warn early. It is NOT the boundary — the
 * server refuses the request regardless of what this returns.
 */
export function wouldLockSelfOut(
  roleId: string,
  proposedCodes: string[],
  callerRoles: Pick<AdminRole, 'id' | 'rolePermissions'>[],
): boolean {
  if (!callerRoles.some((r) => r.id === roleId)) return false;
  const after = new Set<string>();
  for (const role of callerRoles) {
    for (const code of role.id === roleId ? proposedCodes : permissionCodesOf(role)) after.add(code);
  }
  return SELF_ADMINISTRATION_CODES.some((code) => !after.has(code));
}

/** The roles a given user holds, resolved against the role list. */
export function rolesOfUser(user: Pick<AdminUser, 'userRoles'>, roles: AdminRole[]): AdminRole[] {
  const held = new Set(user.userRoles.map((ur) => ur.role.id));
  return roles.filter((r) => held.has(r.id));
}

export function userTone(user: Pick<AdminUser, 'status'>): 'success' | 'neutral' {
  return user.status === 'ACTIVE' ? 'success' : 'neutral';
}

export function isSuspended(user: Pick<AdminUser, 'status'>): boolean {
  return user.status === 'SUSPENDED';
}

export function branchTone(branch: Pick<AdminBranch, 'isActive'>): 'success' | 'neutral' {
  return branch.isActive ? 'success' : 'neutral';
}

export function warehouseTone(warehouse: Pick<AdminWarehouse, 'isActive'>): 'success' | 'neutral' {
  return warehouse.isActive ? 'success' : 'neutral';
}

/** The warehouses of one branch — the grouping the screen renders, since
 *  `isDefault` is scoped to a branch rather than to the business. */
export function warehousesOfBranch(warehouses: AdminWarehouse[], branchId: string): AdminWarehouse[] {
  return warehouses.filter((w) => w.branchId === branchId);
}

/** Permission codes grouped by their leading segment, which is how the
 *  catalog reads to a human: `products.*`, `sales.*`, `reports.*`. The
 *  grouping is derived from the codes the SERVER sent, never from a list
 *  of groups written down here. */
export function groupPermissions(catalog: PermissionCatalogEntry[]): [string, PermissionCatalogEntry[]][] {
  const groups = new Map<string, PermissionCatalogEntry[]>();
  for (const entry of catalog) {
    const group = entry.code.split('.')[0] ?? entry.code;
    const list = groups.get(group) ?? [];
    list.push(entry);
    groups.set(group, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function auditTone(action: AuditAction): 'success' | 'brand' | 'danger' | 'warning' | 'neutral' {
  if (action === 'CREATE') return 'success';
  if (action === 'UPDATE') return 'brand';
  if (action === 'DELETE') return 'danger';
  if (action === 'LOGIN_FAILED' || action === 'PERMISSION_DENIED') return 'warning';
  return 'neutral';
}

/**
 * The audit log's before/after payloads are whatever the mutating
 * use-case recorded. The server never writes a password, a hash or a
 * token into one — but this renderer strips anything credential-shaped
 * regardless, because an audit viewer is the last place that should be
 * the only thing standing between a future logging mistake and a screen.
 */
const CREDENTIAL_KEY = /password|hash|token|secret|apikey|api_key|salt|credential/i;

export function redactAuditPayload(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactAuditPayload);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = CREDENTIAL_KEY.test(key) ? '[redacted]' : redactAuditPayload(val);
  }
  return out;
}

/** Whether an audit row carries anything worth expanding. */
export function hasAuditPayload(row: Pick<AuditLogRow, 'before' | 'after'>): boolean {
  return row.before !== null || row.after !== null;
}
