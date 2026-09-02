import { describe, expect, it } from 'vitest';
import {
  auditActionTone,
  auditActorLabel,
  auditSnapshot,
  auditTotalPages,
  branchNamesOf,
  businessFormFrom,
  businessPatch,
  callerRoleIds,
  canDeleteRole,
  canRenameRole,
  groupPermissions,
  hasChanges,
  isScopedToAllBranches,
  matchesUserSearch,
  nextBusinessForm,
  permissionCodesOf,
  permissionDomain,
  removedRoleAdminCodes,
  roleEditBlock,
  roleNamesOf,
  rolePermissionCatalog,
  selectedInGroup,
  sortUsers,
  toggleGroup,
  userStatusTone,
  warehousesByBranch,
  ROLE_ADMIN_CODES,
} from './admin';
import type { AdminUser, AuditLogRow, Branch, BusinessProfile, PermissionCatalogEntry, Role, Warehouse } from './apiTypes';

/**
 * Phase 20 — the administration screens' decisions, tested away from React.
 *
 * The cases that matter most are the SECURITY mirrors: Decision B is
 * enforced by the backend (`test/role-administration-lockout.e2e-spec.ts`
 * proves that against a real database), and what is checked here is that
 * the browser's explanation of it never contradicts the server and never
 * errs permissive — including the case where the browser cannot know the
 * answer at all.
 */

function user(over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 'u1',
    businessId: 'b1',
    name: 'Amina',
    email: 'amina@shop.test',
    status: 'ACTIVE',
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    userRoles: [],
    userBranches: [],
    ...over,
  };
}

function role(over: Partial<Role> = {}): Role {
  return {
    id: 'r1',
    businessId: 'b1',
    name: 'BUSINESS_OWNER',
    isSystem: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rolePermissions: [
      { permission: { id: 'p1', code: 'roles.view', description: 'View roles' } },
      { permission: { id: 'p2', code: 'roles.edit', description: 'Edit roles' } },
      { permission: { id: 'p3', code: 'products.view', description: 'View products' } },
    ],
    ...over,
  };
}

// ============================================== Decision B, mirrored ====

describe('Decision B, as the roles screen explains it', () => {
  it('names exactly the two codes that make role administration reachable', () => {
    expect(ROLE_ADMIN_CODES).toEqual(['roles.view', 'roles.edit']);
  });

  it('blocks removing roles.view from a role the caller holds', () => {
    const r = role();
    expect(roleEditBlock({ role: r, nextCodes: ['roles.edit', 'products.view'], callerRoleIds: ['r1'] })).toEqual({
      reason: 'roleAdminLockout',
      codes: ['roles.view'],
    });
  });

  it('blocks removing roles.edit, and names both when both go', () => {
    const r = role();
    expect(roleEditBlock({ role: r, nextCodes: ['products.view'], callerRoleIds: ['r1'] })).toEqual({
      reason: 'roleAdminLockout',
      codes: ['roles.view', 'roles.edit'],
    });
  });

  it('does NOT block when the caller does not hold the role being edited', () => {
    const r = role({ id: 'r2', isSystem: false });
    expect(roleEditBlock({ role: r, nextCodes: ['products.view'], callerRoleIds: ['r1'] })).toBeNull();
  });

  it('does NOT block a change that leaves role administration intact', () => {
    const r = role();
    expect(roleEditBlock({ role: r, nextCodes: ['roles.view', 'roles.edit'], callerRoleIds: ['r1'] })).toBeNull();
  });

  it('does NOT block adding permissions to a role the caller holds', () => {
    const r = role();
    const next = [...permissionCodesOf(r), 'audit.view'];
    expect(roleEditBlock({ role: r, nextCodes: next, callerRoleIds: ['r1'] })).toBeNull();
  });

  it('stays silent when the browser cannot know the caller\'s roles — the server answers', () => {
    // The caller may hold `roles.view` without `users.view`, so the user
    // list never loads. Predicting a block here would hide a legal edit;
    // predicting "allowed" is what the server is for.
    const r = role();
    expect(roleEditBlock({ role: r, nextCodes: ['products.view'], callerRoleIds: null })).toBeNull();
  });

  it('blocks renaming a system role, whether or not the caller holds it', () => {
    expect(roleEditBlock({ role: role(), nextName: 'OWNER', callerRoleIds: null })).toEqual({ reason: 'systemRename' });
    expect(roleEditBlock({ role: role(), nextName: 'OWNER', callerRoleIds: ['r1'] })).toEqual({
      reason: 'systemRename',
    });
  });

  it('treats a system role\'s own name, and whitespace around it, as no rename', () => {
    expect(roleEditBlock({ role: role(), nextName: 'BUSINESS_OWNER', callerRoleIds: null })).toBeNull();
    expect(roleEditBlock({ role: role(), nextName: '  BUSINESS_OWNER  ', callerRoleIds: null })).toBeNull();
  });

  it('lets a custom role be renamed freely', () => {
    const custom = role({ id: 'r9', name: 'STOCKTAKER', isSystem: false });
    expect(roleEditBlock({ role: custom, nextName: 'STOCK_TAKER', callerRoleIds: ['r9'] })).toBeNull();
    expect(canRenameRole(custom)).toBe(true);
    expect(canRenameRole(role())).toBe(false);
  });

  it('the rename block wins over the lockout block, matching the order the server checks them', () => {
    expect(roleEditBlock({ role: role(), nextName: 'OWNER', nextCodes: [], callerRoleIds: ['r1'] })).toEqual({
      reason: 'systemRename',
    });
  });

  it('reports removed role-administration codes independently of any role', () => {
    expect(removedRoleAdminCodes(['roles.view', 'roles.edit'], ['roles.view'])).toEqual(['roles.edit']);
    expect(removedRoleAdminCodes(['products.view'], [])).toEqual([]);
    expect(removedRoleAdminCodes([], ['roles.view'])).toEqual([]);
  });

  it('offers deletion only for custom roles — the server refuses the rest', () => {
    expect(canDeleteRole(role())).toBe(false);
    expect(canDeleteRole(role({ isSystem: false }))).toBe(true);
  });
});

// ====================================== the caller's own role identity ===

describe('callerRoleIds', () => {
  const users = [
    user({ id: 'u1', userRoles: [{ role: { id: 'r1', name: 'BUSINESS_OWNER' } }] }),
    user({ id: 'u2', userRoles: [{ role: { id: 'r2', name: 'CASHIER' } }] }),
  ];

  it('reads the roles of the signed-in caller, by id', () => {
    expect(callerRoleIds(users, 'u1')).toEqual(['r1']);
    expect(callerRoleIds(users, 'u2')).toEqual(['r2']);
  });

  it('is null — not an empty list — when the list never loaded', () => {
    expect(callerRoleIds(undefined, 'u1')).toBeNull();
  });

  it('is null when the caller is not in the list, rather than claiming they hold nothing', () => {
    expect(callerRoleIds(users, 'u404')).toBeNull();
  });

  it('is null when there is no signed-in caller id', () => {
    expect(callerRoleIds(users, undefined)).toBeNull();
  });

  it('never consults a role NAME', () => {
    const renamed = [user({ id: 'u1', userRoles: [{ role: { id: 'r1', name: 'literally anything' } }] })];
    expect(callerRoleIds(renamed, 'u1')).toEqual(['r1']);
  });
});

// ================================================================ users ==

describe('users list', () => {
  it('puts active users above suspended ones, then sorts by name', () => {
    const rows = [
      user({ id: 'a', name: 'Zaid', status: 'ACTIVE' }),
      user({ id: 'b', name: 'Ahmed', status: 'SUSPENDED' }),
      user({ id: 'c', name: 'Basma', status: 'ACTIVE' }),
    ];
    expect(sortUsers(rows).map((u) => u.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the array it was given', () => {
    const rows = [user({ id: 'a', name: 'Zaid' }), user({ id: 'b', name: 'Ahmed' })];
    sortUsers(rows);
    expect(rows.map((u) => u.id)).toEqual(['a', 'b']);
  });

  it('narrows on name, email or role name, case-insensitively', () => {
    const u = user({ name: 'Amina', email: 'amina@shop.test', userRoles: [{ role: { id: 'r1', name: 'CASHIER' } }] });
    expect(matchesUserSearch(u, 'AMIN')).toBe(true);
    expect(matchesUserSearch(u, 'shop.test')).toBe(true);
    expect(matchesUserSearch(u, 'cashier')).toBe(true);
    expect(matchesUserSearch(u, 'inventory')).toBe(false);
  });

  it('matches everything on an empty or whitespace term', () => {
    expect(matchesUserSearch(user(), '')).toBe(true);
    expect(matchesUserSearch(user(), '   ')).toBe(true);
  });

  it('reads an empty branch scope as every branch, not as missing data', () => {
    expect(isScopedToAllBranches(user())).toBe(true);
    expect(isScopedToAllBranches(user({ userBranches: [{ branch: { id: 'b1', name: 'Main' } }] }))).toBe(false);
  });

  it('lists roles and branches in a stable order', () => {
    const u = user({
      userRoles: [{ role: { id: 'r2', name: 'CASHIER' } }, { role: { id: 'r1', name: 'ACCOUNTANT' } }],
      userBranches: [{ branch: { id: 'b2', name: 'Zamalek' } }, { branch: { id: 'b1', name: 'Maadi' } }],
    });
    expect(roleNamesOf(u)).toEqual(['ACCOUNTANT', 'CASHIER']);
    expect(branchNamesOf(u)).toEqual(['Maadi', 'Zamalek']);
  });

  it('tones a suspended account as a warning, not a success', () => {
    expect(userStatusTone('ACTIVE')).toBe('success');
    expect(userStatusTone('SUSPENDED')).toBe('warning');
  });
});

// ================================================== permission catalogue =

describe('permission catalogue', () => {
  const catalog: PermissionCatalogEntry[] = [
    { id: '1', code: 'users.view', description: 'View users' },
    { id: '2', code: 'reports.sales.view', description: 'Sales reports' },
    { id: '3', code: 'users.create', description: 'Create users' },
    { id: '4', code: 'audit.view', description: 'View audit logs' },
  ];

  it('takes the domain from the code itself, including nested codes', () => {
    expect(permissionDomain('users.view')).toBe('users');
    expect(permissionDomain('reports.sales.view')).toBe('reports');
    expect(permissionDomain('nodots')).toBe('nodots');
  });

  it('groups by domain, with both groups and codes sorted', () => {
    const groups = groupPermissions(catalog);
    expect(groups.map((g) => g.domain)).toEqual(['audit', 'reports', 'users']);
    expect(groups[2].permissions.map((p) => p.code)).toEqual(['users.create', 'users.view']);
  });

  it('counts what a draft role holds inside a group', () => {
    const users = groupPermissions(catalog).find((g) => g.domain === 'users')!;
    expect(selectedInGroup(users, new Set(['users.view']))).toBe(1);
    expect(selectedInGroup(users, new Set(['users.view', 'users.create']))).toBe(2);
    expect(selectedInGroup(users, new Set())).toBe(0);
  });

  it('toggling a partly-held domain grants the rest; toggling a full one clears it', () => {
    const users = groupPermissions(catalog).find((g) => g.domain === 'users')!;
    expect([...toggleGroup(users, new Set(['users.view']))].sort()).toEqual(['users.create', 'users.view']);
    expect([...toggleGroup(users, new Set(['users.view', 'users.create']))]).toEqual([]);
  });

  it('toggling a domain leaves other domains alone', () => {
    const users = groupPermissions(catalog).find((g) => g.domain === 'users')!;
    const next = toggleGroup(users, new Set(['audit.view']));
    expect(next.has('audit.view')).toBe(true);
  });

  it('handles an empty catalogue without inventing a group', () => {
    expect(groupPermissions([])).toEqual([]);
  });

  it("falls back to a role's own grants for a caller who cannot read the catalogue", () => {
    // `roles.view` without `permissions.view` is a real combination. The
    // role payload already carries each granted permission's code and
    // description, so the set the role DOES grant is shown from data in
    // hand — and what it does not grant stays unknown, which is honest.
    const entries = rolePermissionCatalog(role());
    expect(entries.map((e) => e.code).sort()).toEqual(['products.view', 'roles.edit', 'roles.view']);
    expect(entries.every((e) => typeof e.description === 'string' && e.description.length > 0)).toBe(true);
    expect(groupPermissions(entries).map((g) => g.domain)).toEqual(['products', 'roles']);
  });
});

// ========================================================= organisation ==

describe('organisation', () => {
  const branches: Branch[] = [
    {
      id: 'b1',
      businessId: 'biz',
      name: 'Maadi',
      address: null,
      phone: null,
      isActive: true,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'b2',
      businessId: 'biz',
      name: 'Zamalek',
      address: null,
      phone: null,
      isActive: false,
      createdAt: '',
      updatedAt: '',
    },
  ];
  const warehouses: Warehouse[] = [
    { id: 'w1', businessId: 'biz', branchId: 'b1', name: 'Maadi Main', isDefault: true, isActive: true },
    { id: 'w2', businessId: 'biz', branchId: 'b2', name: 'Zamalek Main', isDefault: true, isActive: true },
    { id: 'w3', businessId: 'biz', branchId: 'b1', name: 'Maadi Overflow', isDefault: false, isActive: false },
  ];

  it('groups warehouses under the branch that owns them, in branch order', () => {
    const grouped = warehousesByBranch(branches, warehouses);
    expect(grouped.map((g) => g.branch.id)).toEqual(['b1', 'b2']);
    expect(grouped[0].warehouses.map((w) => w.id)).toEqual(['w1', 'w3']);
    expect(grouped[1].warehouses.map((w) => w.id)).toEqual(['w2']);
  });

  it('keeps a branch with no warehouses in the list rather than dropping it', () => {
    const grouped = warehousesByBranch(branches, []);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].warehouses).toEqual([]);
  });
});

// ===================================================== business profile ==

describe('business profile patch', () => {
  const profile: BusinessProfile = {
    id: 'biz',
    name: 'Shop',
    slug: 'shop',
    currency: 'EGP',
    timezone: 'Africa/Cairo',
    status: 'ACTIVE',
    legalName: 'Shop LLC',
    taxNumber: '123',
    registrationNumber: null,
    phone: null,
    email: null,
    addressLine: null,
    city: null,
    country: null,
    logoUrl: null,
    receiptHeader: null,
    receiptFooter: null,
  };

  it('sends nothing when nothing changed', () => {
    const patch = businessPatch(profile, businessFormFrom(profile));
    expect(patch).toEqual({});
    expect(hasChanges(patch)).toBe(false);
  });

  it('sends null — not an empty string — for a field the user cleared', () => {
    const form = { ...businessFormFrom(profile), taxNumber: '' };
    expect(businessPatch(profile, form)).toEqual({ taxNumber: null });
  });

  it('leaves an already-empty field out entirely, so a save never re-clears it', () => {
    const form = businessFormFrom(profile);
    expect(form.phone).toBe('');
    expect('phone' in businessPatch(profile, form)).toBe(false);
  });

  it('trims what it sends', () => {
    const form = { ...businessFormFrom(profile), legalName: '  Shop Trading LLC  ' };
    expect(businessPatch(profile, form)).toEqual({ legalName: 'Shop Trading LLC' });
  });

  it('upper-cases a currency, which the backend stores as a code', () => {
    const form = { ...businessFormFrom(profile), currency: 'usd' };
    expect(businessPatch(profile, form)).toEqual({ currency: 'USD' });
  });

  it('never sends an empty required field — the previous value stands', () => {
    const form = { ...businessFormFrom(profile), name: '   ', currency: '', timezone: '' };
    expect(businessPatch(profile, form)).toEqual({});
  });

  /**
   * Saving invalidates the business query, so its response lands a moment
   * after the save — by which time the operator may already be typing, or
   * clearing, the next field. These are the cases that keystroke must
   * survive.
   */
  describe('a fresh profile arriving from the server', () => {
    const incoming: BusinessProfile = { ...profile, city: 'Cairo', registrationNumber: 'REG-9' };

    it('seeds the form the first time', () => {
      expect(nextBusinessForm(profile, null, false).name).toBe('Shop');
    });

    it('re-seeds an untouched form, so a background refresh is visible', () => {
      const clean = businessFormFrom(profile);
      expect(nextBusinessForm(incoming, clean, false).city).toBe('Cairo');
    });

    it('KEEPS a touched form rather than wiping what the operator typed', () => {
      const typing = { ...businessFormFrom(profile), phone: '0100' };
      expect(nextBusinessForm(incoming, typing, true)).toBe(typing);
    });

    /**
     * The case that made this a flag rather than a value comparison.
     *
     * The operator CLEARS a field. In the copy the form was seeded from
     * that field was already empty, so the form and its seed are identical
     * — a diff-based "is this dirty" check says "nothing changed" and the
     * arriving copy, which has the value, overwrites the clear. The
     * operator watches the field they just emptied fill itself back in.
     */
    it('keeps a CLEARED field even though clearing it matched the stale copy', () => {
      const cleared = { ...businessFormFrom(profile), registrationNumber: '' };
      expect(businessPatch(profile, cleared)).toEqual({});
      expect(nextBusinessForm(incoming, cleared, true).registrationNumber).toBe('');
    });

    it('still diffs a kept form against the NEWER copy, so it saves what it shows', () => {
      const typing = { ...businessFormFrom(profile), phone: '0100' };
      const kept = nextBusinessForm(incoming, typing, true);
      // Both the typed field and the differences the operator can see on
      // screen are sent: their form shows an empty city, so saving means
      // "city is empty". Diffing against the stale copy would quietly leave
      // values the operator never saw.
      expect(businessPatch(incoming, kept)).toEqual({ phone: '0100', city: null, registrationNumber: null });
    });

    it('seeds from the incoming copy when there is no form yet, touched or not', () => {
      expect(nextBusinessForm(incoming, null, true).city).toBe('Cairo');
    });
  });

  it('carries a null profile field into the form as an empty string', () => {
    expect(businessFormFrom(profile).registrationNumber).toBe('');
    expect(businessFormFrom(profile).legalName).toBe('Shop LLC');
  });
});

// ================================================================ audit ==

describe('audit log', () => {
  function row(over: Partial<AuditLogRow> = {}): AuditLogRow {
    return {
      id: 'a1',
      businessId: 'biz',
      userId: 'u1',
      action: 'UPDATE',
      entityType: 'Role',
      entityId: 'r1',
      before: null,
      after: null,
      reason: null,
      ipAddress: null,
      userAgent: null,
      requestId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...over,
    };
  }

  it('works out the last page the server did not send', () => {
    expect(auditTotalPages({ total: 0, limit: 50 })).toBe(1);
    expect(auditTotalPages({ total: 50, limit: 50 })).toBe(1);
    expect(auditTotalPages({ total: 51, limit: 50 })).toBe(2);
    expect(auditTotalPages({ total: 199, limit: 50 })).toBe(4);
  });

  it('never divides by a zero limit', () => {
    expect(auditTotalPages({ total: 10, limit: 0 })).toBe(1);
  });

  it('tones the actions a security review is looking for', () => {
    expect(auditActionTone('PERMISSION_DENIED')).toBe('danger');
    expect(auditActionTone('LOGIN_FAILED')).toBe('danger');
    expect(auditActionTone('DELETE')).toBe('danger');
    expect(auditActionTone('CREATE')).toBe('success');
    expect(auditActionTone('LOGIN')).toBe('neutral');
  });

  it('names the actor when the caller can see the user list, and keeps the id when not', () => {
    const users = [user({ id: 'u1', name: 'Amina' })];
    expect(auditActorLabel(row(), users)).toBe('Amina');
    expect(auditActorLabel(row(), undefined)).toBe('u1');
    expect(auditActorLabel(row({ userId: 'gone' }), users)).toBe('gone');
  });

  it('has no actor for a row that records no user', () => {
    expect(auditActorLabel(row({ userId: null }), undefined)).toBeNull();
  });

  it('renders a snapshot only when it carries something', () => {
    expect(auditSnapshot(null)).toBeNull();
    expect(auditSnapshot(undefined)).toBeNull();
    expect(auditSnapshot({})).toBeNull();
    expect(auditSnapshot({ name: 'CASHIER' })).toBe('{\n  "name": "CASHIER"\n}');
  });
});
