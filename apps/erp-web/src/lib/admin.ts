import type {
  AdminUser,
  AuditLogRow,
  Branch,
  BusinessProfile,
  PermissionCatalogEntry,
  PermissionCode,
  Role,
  UserStatus,
  Warehouse,
} from './apiTypes';
import type { BadgeTone } from '@retail/ui-kit';

/**
 * Phase 20 — the administration screens' decisions, out of the components
 * and under test.
 *
 * NOTHING IN THIS FILE AUTHORIZES ANYTHING. Every rule mirrored here is
 * enforced by the backend and re-checked on every request; the mirror
 * exists so a screen can explain a refusal BEFORE the round trip instead
 * of only after it. Where the mirror cannot know the answer it says so
 * (`null`) and lets the server answer — it never guesses in the
 * permissive direction.
 */

/**
 * The two codes that make role administration reachable at all.
 *
 * Kept in step with `ROLE_ADMIN_CODES` in
 * `apps/api/src/modules/iam/application/roles/update-role.use-case.ts`,
 * which is the enforcing copy.
 */
export const ROLE_ADMIN_CODES: PermissionCode[] = ['roles.view', 'roles.edit'];

// ------------------------------------------------------------- users ----

/** Sort order the users screen shows: active before suspended, then by
 *  name, so the people who can currently sign in are at the top. */
export function sortUsers(users: AdminUser[]): AdminUser[] {
  return [...users].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'ACTIVE' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * `GET /users` takes no `search` parameter, so narrowing happens here on
 * the page the caller already received — and the screen says as much
 * rather than implying the server searched.
 */
export function matchesUserSearch(user: AdminUser, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return (
    user.name.toLowerCase().includes(needle) ||
    user.email.toLowerCase().includes(needle) ||
    user.userRoles.some((ur) => ur.role.name.toLowerCase().includes(needle))
  );
}

export function userStatusTone(status: UserStatus): BadgeTone {
  return status === 'ACTIVE' ? 'success' : 'warning';
}

export function roleNamesOf(user: AdminUser): string[] {
  return user.userRoles.map((ur) => ur.role.name).sort();
}

/**
 * Which branches a user is scoped to, as names.
 *
 * An EMPTY list is not an absence of information: the model treats no
 * branch rows as "every branch, subject to permissions", so the screen
 * renders that meaning rather than a dash.
 */
export function branchNamesOf(user: AdminUser): string[] {
  return user.userBranches.map((ub) => ub.branch.name).sort();
}

export function isScopedToAllBranches(user: AdminUser): boolean {
  return user.userBranches.length === 0;
}

/**
 * The role ids the SIGNED-IN caller actually holds.
 *
 * Derived from the real user list for the real caller id — never from a
 * role name, never from a module-level guess, and never from anything the
 * caller could type. Returns `null` when the answer is genuinely unknown
 * (the caller lacks `users.view`, so the list never loaded, or their own
 * row is not in it); callers must treat `null` as "ask the server", not
 * as "no roles".
 */
export function callerRoleIds(users: AdminUser[] | undefined, callerUserId: string | undefined): string[] | null {
  if (!users || !callerUserId) return null;
  const me = users.find((u) => u.id === callerUserId);
  if (!me) return null;
  return me.userRoles.map((ur) => ur.role.id);
}

// ------------------------------------------------------------- roles ----

export function permissionCodesOf(role: Role): PermissionCode[] {
  return role.rolePermissions.map((rp) => rp.permission.code).sort();
}

/** Which role-administration codes a proposed permission set would take
 *  away from what the role currently grants. */
export function removedRoleAdminCodes(currentCodes: PermissionCode[], nextCodes: PermissionCode[]): PermissionCode[] {
  const held = new Set(currentCodes);
  const next = new Set(nextCodes);
  return ROLE_ADMIN_CODES.filter((code) => held.has(code) && !next.has(code));
}

/** Why the server would refuse this role edit — or `null` if it would not.
 *  Mirrors Decision B; it does not replace it. */
export type RoleEditBlock =
  | { reason: 'systemRename' }
  | { reason: 'roleAdminLockout'; codes: PermissionCode[] }
  | null;

/**
 * Decision B, as a screen can explain it in advance.
 *
 * `callerRoleIds` of `null` means the browser does not know which roles
 * the caller holds, so the lockout half is NOT predicted: an unknown is
 * left to the server, which always knows. The rename half needs no such
 * knowledge — `isSystem` arrives with the role.
 */
export function roleEditBlock(input: {
  role: Role;
  nextName?: string;
  nextCodes?: PermissionCode[];
  callerRoleIds: string[] | null;
}): RoleEditBlock {
  const { role, nextName, nextCodes, callerRoleIds: heldRoleIds } = input;

  if (role.isSystem && nextName !== undefined && nextName.trim() !== role.name) {
    return { reason: 'systemRename' };
  }

  if (nextCodes && heldRoleIds && heldRoleIds.includes(role.id)) {
    const codes = removedRoleAdminCodes(permissionCodesOf(role), nextCodes);
    if (codes.length > 0) return { reason: 'roleAdminLockout', codes };
  }

  return null;
}

/** A system template's name is fixed (Decision B rule 4); its permissions
 *  are not (rule 2). */
export function canRenameRole(role: Role): boolean {
  return !role.isSystem;
}

/** The server also refuses a role that is still assigned to someone — a
 *  fact this screen does not receive, so the button is offered and the
 *  409 is shown verbatim rather than predicted. */
export function canDeleteRole(role: Role): boolean {
  return !role.isSystem;
}

/**
 * The permission catalogue, grouped by the domain in each code.
 *
 * A flat list of 117 checkboxes is not a role editor. The domain is the
 * segment before the first dot — `users.view` groups under `users`,
 * `reports.sales.view` under `reports` — which is the catalogue's own
 * naming, not a taxonomy invented here. Groups and the codes inside them
 * come out sorted, so the list is stable between renders.
 */
export interface PermissionGroup {
  domain: string;
  permissions: PermissionCatalogEntry[];
}

export function permissionDomain(code: PermissionCode): string {
  const dot = code.indexOf('.');
  return dot === -1 ? code : code.slice(0, dot);
}

/**
 * A role's own grants, in catalogue shape.
 *
 * For the caller who may read roles but not the permission catalogue: the
 * role payload already carries each granted permission's id, code and
 * description, so its own set can be shown without the endpoint they lack.
 * What is missing is everything the role does NOT grant — which is
 * precisely what `permissions.view` is for, and is not faked here.
 */
export function rolePermissionCatalog(role: Role): PermissionCatalogEntry[] {
  return role.rolePermissions.map((rp) => rp.permission);
}

export function groupPermissions(catalog: PermissionCatalogEntry[]): PermissionGroup[] {
  const groups = new Map<string, PermissionCatalogEntry[]>();
  for (const entry of catalog) {
    const domain = permissionDomain(entry.code);
    const bucket = groups.get(domain);
    if (bucket) bucket.push(entry);
    else groups.set(domain, [entry]);
  }
  return [...groups.entries()]
    .map(([domain, permissions]) => ({
      domain,
      permissions: [...permissions].sort((a, b) => a.code.localeCompare(b.code)),
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

/** How many of a group's codes the draft role currently grants — the
 *  number beside a collapsed section, and what drives its select-all. */
export function selectedInGroup(group: PermissionGroup, selected: Set<PermissionCode>): number {
  return group.permissions.filter((p) => selected.has(p.code)).length;
}

/** Toggling a whole domain: if every code in it is already held, the
 *  toggle clears them; otherwise it grants the ones missing. */
export function toggleGroup(group: PermissionGroup, selected: Set<PermissionCode>): Set<PermissionCode> {
  const next = new Set(selected);
  const all = selectedInGroup(group, selected) === group.permissions.length;
  for (const p of group.permissions) {
    if (all) next.delete(p.code);
    else next.add(p.code);
  }
  return next;
}

// ------------------------------------------------------ organisation ----

export function branchTone(branch: Branch): BadgeTone {
  return branch.isActive ? 'success' : 'neutral';
}

export function warehouseTone(warehouse: Warehouse): BadgeTone {
  return warehouse.isActive ? 'success' : 'neutral';
}

export function branchNameById(branches: Branch[], branchId: string): string | undefined {
  return branches.find((b) => b.id === branchId)?.name;
}

/** Warehouses grouped under the branch that owns them, in branch order,
 *  because "which branch is this shelf in" is the only question the list
 *  is ever read to answer. */
export function warehousesByBranch(
  branches: Branch[],
  warehouses: Warehouse[],
): { branch: Branch; warehouses: Warehouse[] }[] {
  return branches.map((branch) => ({
    branch,
    warehouses: warehouses.filter((w) => w.branchId === branch.id),
  }));
}

// --------------------------------------------------- business profile ---

/** The profile fields `PATCH /business` accepts as nullable free text.
 *  `name`, `currency` and `timezone` are NOT here: they are not nullable
 *  and are edited as required fields. */
export const BUSINESS_PROFILE_FIELDS = [
  'legalName',
  'taxNumber',
  'registrationNumber',
  'phone',
  'email',
  'addressLine',
  'city',
  'country',
  'logoUrl',
  'receiptHeader',
  'receiptFooter',
] as const;

export type BusinessProfileField = (typeof BUSINESS_PROFILE_FIELDS)[number];

export type BusinessForm = { name: string; currency: string; timezone: string } & Record<BusinessProfileField, string>;

export function businessFormFrom(profile: BusinessProfile): BusinessForm {
  const form = {
    name: profile.name,
    currency: profile.currency,
    timezone: profile.timezone,
  } as BusinessForm;
  for (const field of BUSINESS_PROFILE_FIELDS) form[field] = profile[field] ?? '';
  return form;
}

/**
 * Only what actually changed is sent, and an emptied field is sent as
 * `null` rather than `''`.
 *
 * The contract draws a real distinction — `null` CLEARS a field, omitting
 * it leaves it alone — and flattening the two would turn "I did not touch
 * the tax number" into "delete the tax number" on every save.
 */
export function businessPatch(original: BusinessProfile, form: BusinessForm): Record<string, string | null> {
  const patch: Record<string, string | null> = {};

  const name = form.name.trim();
  if (name && name !== original.name) patch.name = name;
  const currency = form.currency.trim().toUpperCase();
  if (currency && currency !== original.currency) patch.currency = currency;
  const timezone = form.timezone.trim();
  if (timezone && timezone !== original.timezone) patch.timezone = timezone;

  for (const field of BUSINESS_PROFILE_FIELDS) {
    const typed = form[field].trim();
    const next = typed === '' ? null : typed;
    if (next !== (original[field] ?? null)) patch[field] = next;
  }

  return patch;
}

export function hasChanges(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).length > 0;
}

/**
 * What the profile form should hold when a fresh copy arrives from the
 * server.
 *
 * THE CASE THIS EXISTS FOR. Saving invalidates the business query, so its
 * response lands a second or so after the save — by which time the operator
 * may already be typing, or clearing, the next field. Re-seeding on every
 * arriving profile would wipe that keystroke silently: the field they just
 * emptied fills itself back in, with no error and nothing to retry.
 *
 * `touched` — has the operator changed anything since this form was seeded —
 * is what decides, and it is deliberately NOT inferred by diffing the form
 * against the copy it was seeded from. That inference gets the important
 * case exactly wrong: clearing a field that was empty in the STALE copy and
 * non-empty in the arriving one looks identical to "no changes", and the
 * clear is discarded. Whether the operator touched the form is a fact about
 * what they did, not something to be re-derived from values.
 *
 * Once touched, the form is theirs until they save or discard. A background
 * refetch cannot take it back, and the patch is computed against the latest
 * server copy regardless — so a save still sends the difference from what
 * the server actually holds.
 */
export function nextBusinessForm(
  incoming: BusinessProfile,
  current: BusinessForm | null,
  touched: boolean,
): BusinessForm {
  if (!current) return businessFormFrom(incoming);
  return touched ? current : businessFormFrom(incoming);
}

// ------------------------------------------------------------ audit -----

/**
 * `GET /audit-logs` returns `{ total, page, limit }` and no page count, so
 * the last page is worked out here — the one derivation this file makes
 * from server data, and only because the server did not send it.
 */
export function auditTotalPages(meta: { total: number; limit: number }): number {
  if (meta.limit <= 0) return 1;
  return Math.max(1, Math.ceil(meta.total / meta.limit));
}

export function auditActionTone(action: AuditLogRow['action']): BadgeTone {
  switch (action) {
    case 'CREATE':
      return 'success';
    case 'DELETE':
    case 'PERMISSION_DENIED':
    case 'LOGIN_FAILED':
      return 'danger';
    case 'UPDATE':
      return 'brand';
    default:
      return 'neutral';
  }
}

/** Who did it, resolved against the user list when the caller can see one.
 *  A row whose actor is no longer a user — or whose actor the caller may
 *  not read — keeps its raw id rather than being blanked. */
export function auditActorLabel(row: AuditLogRow, users: AdminUser[] | undefined): string | null {
  if (!row.userId) return null;
  return users?.find((u) => u.id === row.userId)?.name ?? row.userId;
}

/** `before`/`after` are whatever the recording module wrote. Rendered as
 *  formatted JSON when there is something to show, and omitted when there
 *  is not — an empty `{}` panel tells nobody anything. */
export function auditSnapshot(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && Object.keys(value as object).length === 0) return null;
  return JSON.stringify(value, null, 2);
}
