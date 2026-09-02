import { describe, expect, it } from 'vitest';
import * as adminLib from './admin';
import {
  ORGANISATION_HAS_NO_DELETE,
  PERMISSION_CATALOG_IS_READ_ONLY,
  SELF_ADMINISTRATION_CODES,
  USERS_LIST_HAS_NO_FILTERS,
  auditTone,
  branchTone,
  canDeleteRole,
  canRenameRole,
  groupPermissions,
  hasAuditPayload,
  isSuspended,
  isSystemRole,
  permissionCodesOf,
  redactAuditPayload,
  roleAssignmentCount,
  rolesOfUser,
  userTone,
  warehouseTone,
  warehousesOfBranch,
  wouldLockSelfOut,
} from './admin';
import type { AdminRole, AdminUser, AdminWarehouse, AuditAction, PermissionCatalogEntry } from './apiTypes';

/**
 * Phase 20.
 *
 * The case that matters most is `wouldLockSelfOut`, and what matters
 * about it is that it is NOT the boundary. The server refuses a
 * self-locking role edit itself (`UpdateRoleUseCase`, owner decision B);
 * this copy exists so the dialog can warn before submitting. These cases
 * pin that it computes the SAME thing the server does — the union over
 * every role the caller holds, with the edited role's set replaced — so
 * the warning and the refusal never disagree.
 */

function role(over: Partial<AdminRole> = {}): AdminRole {
  return {
    id: 'r-1',
    businessId: 'b-1',
    name: 'CUSTOM',
    isSystem: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rolePermissions: [],
    ...over,
  };
}
const withCodes = (id: string, codes: string[], over: Partial<AdminRole> = {}) =>
  role({ id, rolePermissions: codes.map((code) => ({ permission: { id: code, code, description: null } })), ...over });

function user(over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 'u-1',
    businessId: 'b-1',
    name: 'Sara',
    email: 'sara@example.test',
    status: 'ACTIVE',
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    userRoles: [],
    userBranches: [],
    ...over,
  };
}

describe('the module boundary', () => {
  it('authorizes nothing — every export is visibility or presentation', () => {
    // No name here may read as an authorization decision: the backend
    // re-checks every call and recomputes effective permissions from the
    // database on each request.
    for (const name of Object.keys(adminLib)) {
      expect(name).not.toMatch(/authorize|authorise|grant|allow(?!.*Delete)|enforce|permit/i);
    }
  });

  it('records the contract limitations the screens are shaped around', () => {
    expect(USERS_LIST_HAS_NO_FILTERS).toBe(true);
    expect(ORGANISATION_HAS_NO_DELETE).toBe(true);
    expect(PERMISSION_CATALOG_IS_READ_ONLY).toBe(true);
  });

  it('names the two grants a caller may never remove from themselves', () => {
    // Without `roles.edit` there is no way to repair a role; without
    // `roles.view` there is no way to find the one to repair.
    expect([...SELF_ADMINISTRATION_CODES]).toEqual(['roles.view', 'roles.edit']);
  });
});

describe('wouldLockSelfOut', () => {
  const mine = [withCodes('admin-role', ['roles.view', 'roles.edit', 'users.view'])];

  it('flags an edit that would cost the caller `roles.edit`', () => {
    expect(wouldLockSelfOut('admin-role', ['roles.view', 'users.view'], mine)).toBe(true);
  });

  it('flags an edit that would cost the caller `roles.view`', () => {
    expect(wouldLockSelfOut('admin-role', ['roles.edit', 'users.view'], mine)).toBe(true);
  });

  it('flags the exact edit that bricked a tenant during discovery', () => {
    expect(wouldLockSelfOut('admin-role', ['products.view'], mine)).toBe(true);
  });

  it('allows an edit that keeps both', () => {
    expect(wouldLockSelfOut('admin-role', ['roles.view', 'roles.edit'], mine)).toBe(false);
  });

  it('ignores a role the caller does NOT hold', () => {
    // Removing a colleague's administration is an ordinary act, not a
    // lockout — and the server allows it too.
    expect(wouldLockSelfOut('someone-elses-role', [], mine)).toBe(false);
  });

  it('allows stripping one of TWO roles that both carry administration', () => {
    // The reason the union is computed rather than checking this role
    // alone: the other role still carries it, so the edit is safe and
    // must not be warned about.
    const twoRoles = [
      withCodes('admin-role', ['roles.view', 'roles.edit']),
      withCodes('spare-role', ['roles.view', 'roles.edit', 'products.view']),
    ];
    expect(wouldLockSelfOut('admin-role', ['products.view'], twoRoles)).toBe(false);
  });

  it('flags it when the OTHER role does not carry administration', () => {
    const twoRoles = [withCodes('admin-role', ['roles.view', 'roles.edit']), withCodes('spare-role', ['products.view'])];
    expect(wouldLockSelfOut('admin-role', ['products.view'], twoRoles)).toBe(true);
  });

  it('warns about nothing when the caller’s own roles are unknown', () => {
    // The users list may be unreadable to this caller. No warning is
    // shown and the SERVER remains the only check — the correct
    // direction to fail in.
    expect(wouldLockSelfOut('admin-role', [], [])).toBe(false);
  });
});

describe('role rules mirrored from the server', () => {
  it('reads `isSystem` as a FLAG, never a name comparison', () => {
    expect(isSystemRole(role({ isSystem: true, name: 'CUSTOM' }))).toBe(true);
    expect(isSystemRole(role({ isSystem: false, name: 'BUSINESS_OWNER' }))).toBe(false);
  });

  it('refuses to rename a built-in template, and allows renaming a custom role', () => {
    expect(canRenameRole(role({ isSystem: true }))).toBe(false);
    expect(canRenameRole(role({ isSystem: false }))).toBe(true);
  });

  it('offers deletion only for an unassigned custom role', () => {
    const target = role({ id: 'r-9' });
    const holder = user({ userRoles: [{ role: { id: 'r-9', name: 'CUSTOM' } }] });
    expect(canDeleteRole(target, [])).toBe(true);
    expect(canDeleteRole(target, [holder])).toBe(false);
    expect(canDeleteRole(role({ id: 'r-9', isSystem: true }), [])).toBe(false);
  });

  it('counts who holds a role', () => {
    const holder = user({ id: 'u-1', userRoles: [{ role: { id: 'r-9', name: 'X' } }] });
    const other = user({ id: 'u-2', userRoles: [{ role: { id: 'r-8', name: 'Y' } }] });
    expect(roleAssignmentCount(role({ id: 'r-9' }), [holder, other])).toBe(1);
    expect(roleAssignmentCount(role({ id: 'r-7' }), [holder, other])).toBe(0);
  });

  it('resolves the roles a user holds against the role list', () => {
    const roles = [withCodes('r-1', ['a']), withCodes('r-2', ['b'])];
    const holder = user({ userRoles: [{ role: { id: 'r-2', name: 'B' } }] });
    expect(rolesOfUser(holder, roles).map((r) => r.id)).toEqual(['r-2']);
  });

  it('reads permission codes off a role', () => {
    expect(permissionCodesOf(withCodes('r-1', ['b.view', 'a.view']))).toEqual(['b.view', 'a.view']);
  });
});

describe('groupPermissions', () => {
  const entry = (code: string): PermissionCatalogEntry => ({ id: code, code, description: null });

  it('groups by the leading segment of the code the SERVER sent', () => {
    // Derived from the catalog, never from a list of groups written
    // down here — a hardcoded grouping would go stale the moment the
    // product adds a permission family.
    const groups = groupPermissions([entry('sales.view'), entry('products.view'), entry('sales.create')]);
    expect(groups.map(([g]) => g)).toEqual(['products', 'sales']);
    expect(groups.find(([g]) => g === 'sales')![1].map((e) => e.code)).toEqual(['sales.view', 'sales.create']);
  });

  it('handles a code with no dot rather than dropping it', () => {
    expect(groupPermissions([entry('standalone')]).map(([g]) => g)).toEqual(['standalone']);
  });

  it('returns nothing for an empty catalog', () => {
    expect(groupPermissions([])).toEqual([]);
  });
});

describe('tones and states', () => {
  it('separates an active user from a suspended one', () => {
    expect(userTone({ status: 'ACTIVE' })).toBe('success');
    expect(userTone({ status: 'SUSPENDED' })).toBe('neutral');
    expect(isSuspended({ status: 'SUSPENDED' })).toBe(true);
    expect(isSuspended({ status: 'ACTIVE' })).toBe(false);
  });

  it('separates active branches and warehouses from inactive ones', () => {
    expect(branchTone({ isActive: true })).toBe('success');
    expect(branchTone({ isActive: false })).toBe('neutral');
    expect(warehouseTone({ isActive: true })).toBe('success');
    expect(warehouseTone({ isActive: false })).toBe('neutral');
  });

  it('gives each audit action its own tone, and covers the live enum', () => {
    const all: AuditAction[] = ['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PERMISSION_DENIED'];
    for (const a of all) expect(['success', 'brand', 'danger', 'warning', 'neutral']).toContain(auditTone(a));
    expect(auditTone('DELETE')).toBe('danger');
    expect(auditTone('PERMISSION_DENIED')).toBe('warning');
  });

  it('groups warehouses by branch, because `isDefault` is scoped to one', () => {
    const wh = (id: string, branchId: string): AdminWarehouse => ({
      id,
      businessId: 'b-1',
      branchId,
      name: id,
      isDefault: false,
      isActive: true,
      createdAt: '',
      updatedAt: '',
    });
    const all = [wh('w1', 'br-1'), wh('w2', 'br-2'), wh('w3', 'br-1')];
    expect(warehousesOfBranch(all, 'br-1').map((w) => w.id)).toEqual(['w1', 'w3']);
    expect(warehousesOfBranch(all, 'br-9')).toEqual([]);
  });
});

describe('audit payload redaction', () => {
  it('masks anything credential-shaped, however deeply nested', () => {
    // The server never writes a secret into an audit payload — the
    // password path deliberately records that a change happened and
    // nothing about the value. This is the belt to that braces: an audit
    // viewer must not be the one place a future logging mistake surfaces.
    const redacted = redactAuditPayload({
      name: 'Sara',
      passwordHash: 'argon2id$...',
      nested: { refreshToken: 'abc', apiKey: 'k', deeper: { secret: 's', keep: 1 } },
      list: [{ token: 't', name: 'ok' }],
    }) as Record<string, unknown>;

    expect(redacted.name).toBe('Sara');
    expect(redacted.passwordHash).toBe('[redacted]');
    const nested = redacted.nested as Record<string, unknown>;
    expect(nested.refreshToken).toBe('[redacted]');
    expect(nested.apiKey).toBe('[redacted]');
    expect((nested.deeper as Record<string, unknown>).secret).toBe('[redacted]');
    expect((nested.deeper as Record<string, unknown>).keep).toBe(1);
    expect((redacted.list as Record<string, unknown>[])[0].token).toBe('[redacted]');
    expect((redacted.list as Record<string, unknown>[])[0].name).toBe('ok');
  });

  it('leaves ordinary values, nulls and primitives alone', () => {
    expect(redactAuditPayload(null)).toBeNull();
    expect(redactAuditPayload('plain')).toBe('plain');
    expect(redactAuditPayload({ permissionCodes: ['roles.view'] })).toEqual({ permissionCodes: ['roles.view'] });
  });

  it('knows when a row has nothing worth expanding', () => {
    expect(hasAuditPayload({ before: null, after: null })).toBe(false);
    expect(hasAuditPayload({ before: null, after: { a: 1 } })).toBe(true);
    expect(hasAuditPayload({ before: { a: 1 }, after: null })).toBe(true);
  });
});
