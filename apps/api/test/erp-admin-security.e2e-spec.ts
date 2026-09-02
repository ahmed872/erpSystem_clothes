import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { registerAndLogin, RegisteredBusiness } from './utils/register-and-login';

/**
 * Phase 20 — THE ROLE SELF-LOCKOUT FIX.
 *
 * WHAT WENT WRONG. Phase 20's contract discovery reproduced, end to end,
 * an owner permanently locking their tenant out of its own
 * administration with a single request: `PATCH /roles/:id` pointed at
 * their own role, permission set cut to one code. Afterwards `GET /roles`
 * was 403, patching the role back was 403, and re-login did not help —
 * the role itself had been rewritten. There is no super-admin and no
 * recovery path by design, so the only remedy was direct database
 * access.
 *
 * `DeleteRoleUseCase` already refused to delete a built-in template while
 * `UpdateRoleUseCase` would happily rename one, so the two disagreed
 * about whether `isSystem` meant anything.
 *
 * OWNER DECISION B — "protect self only" — is what these cases pin:
 *   - an update may not leave the CALLER without `roles.view`/`roles.edit`
 *   - a built-in template may not be RENAMED
 *   - a built-in template's PERMISSION SET stays editable
 *   - nothing else changes: no super-admin, no recovery mechanism, no
 *     change to the permission model, and no protection of any OTHER
 *     administrator (removing a colleague's access is an ordinary act).
 */
describe('ERP administration security: role self-lockout (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: RegisteredBusiness;
  let other: RegisteredBusiness;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await registerAndLogin(app, 'admin-sec-a');
    other = await registerAndLogin(app, 'admin-sec-b');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const bearer = (t: string) => `Bearer ${t}`;
  const auth = () => bearer(biz.accessToken);
  const api = () => request(app.getHttpServer());

  async function roles(token = biz.accessToken) {
    const res = await api().get('/api/v1/roles').set('Authorization', bearer(token)).expect(200);
    return res.body.data as { id: string; name: string; isSystem: boolean; rolePermissions: { permission: { code: string } }[] }[];
  }
  async function ownerRole() {
    return (await roles()).find((r) => r.name === 'BUSINESS_OWNER')!;
  }
  const codesOf = (role: { rolePermissions: { permission: { code: string } }[] }) => role.rolePermissions.map((rp) => rp.permission.code);

  /** A second user in the same tenant, on roles of our choosing. */
  async function userOnRoles(handle: string, roleIds: string[]): Promise<string> {
    const email = `${handle}@${biz.slug}.test`;
    await api()
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: handle, email, password: 'ErpUserPass1!', roleIds })
      .expect(201);
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email, password: 'ErpUserPass1!', businessSlug: biz.slug })
      .expect(200);
    return res.body.data.accessToken;
  }
  async function customRole(name: string, permissionCodes: string[]): Promise<string> {
    const res = await api().post('/api/v1/roles').set('Authorization', auth()).send({ name, permissionCodes }).expect(201);
    return res.body.data.id;
  }

  // ================================================================
  // 1. Self-lockout — the blocker itself
  // ================================================================
  describe('a caller cannot remove their own administration access', () => {
    it('refuses to remove `roles.view` from the role the caller holds', async () => {
      const role = await ownerRole();
      const without = codesOf(role).filter((c) => c !== 'roles.view');
      const res = await api()
        .patch(`/api/v1/roles/${role.id}`)
        .set('Authorization', auth())
        .send({ permissionCodes: without })
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toContain('roles.view');
    });

    it('refuses to remove `roles.edit`', async () => {
      const role = await ownerRole();
      const without = codesOf(role).filter((c) => c !== 'roles.edit');
      const res = await api()
        .patch(`/api/v1/roles/${role.id}`)
        .set('Authorization', auth())
        .send({ permissionCodes: without })
        .expect(409);
      expect(res.body.error.message).toContain('roles.edit');
    });

    it('refuses to remove BOTH, and says so', async () => {
      const role = await ownerRole();
      const without = codesOf(role).filter((c) => c !== 'roles.view' && c !== 'roles.edit');
      const res = await api()
        .patch(`/api/v1/roles/${role.id}`)
        .set('Authorization', auth())
        .send({ permissionCodes: without })
        .expect(409);
      expect(res.body.error.message).toContain('roles.view');
      expect(res.body.error.message).toContain('roles.edit');
    });

    it('refuses the exact request that bricked a tenant during discovery', async () => {
      // One code, nothing else. This is the reproduction, verbatim.
      const role = await ownerRole();
      await api()
        .patch(`/api/v1/roles/${role.id}`)
        .set('Authorization', auth())
        .send({ permissionCodes: ['products.view'] })
        .expect(409);
    });

    it('leaves the role COMPLETELY unmodified after a refused update', async () => {
      const before = await ownerRole();
      await api()
        .patch(`/api/v1/roles/${before.id}`)
        .set('Authorization', auth())
        .send({ name: 'Renamed Anyway', permissionCodes: ['products.view'] })
        .expect(409);

      const after = await ownerRole();
      expect(after.name).toBe('BUSINESS_OWNER');
      expect(codesOf(after).sort()).toEqual(codesOf(before).sort());
      // ...and the database agrees, not just the endpoint.
      const rowCount = await admin.rolePermission.count({ where: { roleId: before.id } });
      expect(rowCount).toBe(codesOf(before).length);
    });

    it('leaves the caller fully able to administer afterwards', async () => {
      // The property that actually matters: the tenant is not bricked.
      await api().get('/api/v1/roles').set('Authorization', auth()).expect(200);
      await api().get('/api/v1/users').set('Authorization', auth()).expect(200);
      const mine = await api().get('/api/v1/permissions/me').set('Authorization', auth()).expect(200);
      expect(mine.body.data.permissions).toContain('roles.edit');
      expect(mine.body.data.permissions).toContain('roles.view');
    });

    it('re-login is not needed and does not change the outcome', async () => {
      const res = await api()
        .post('/api/v1/auth/login')
        .send({ email: biz.ownerEmail, password: biz.ownerPassword, businessSlug: biz.slug })
        .expect(200);
      await api().get('/api/v1/roles').set('Authorization', bearer(res.body.data.accessToken)).expect(200);
    });
  });

  // ================================================================
  // 2. The guard is about the CALLER, not about the role
  // ================================================================
  describe('the guard protects the caller, not every role', () => {
    it('allows stripping administration from a role the caller does NOT hold', async () => {
      // Removing a colleague's access is an ordinary administrative act
      // with an audit row behind it — not a lockout, and not blocked.
      const id = await customRole('DEPUTY', ['roles.view', 'roles.edit', 'users.view']);
      await api()
        .patch(`/api/v1/roles/${id}`)
        .set('Authorization', auth())
        .send({ permissionCodes: ['users.view'] })
        .expect(200);
    });

    it('allows a caller holding TWO roles to strip administration from one of them', async () => {
      // The reason the check is made on EFFECTIVE permissions after the
      // change rather than on this role alone: the other role still
      // carries administration, so this edit is safe and must not be
      // refused.
      const adminRoleId = await customRole('ADMIN_SIDE', ['roles.view', 'roles.edit', 'users.view']);
      const otherRoleId = await customRole('SPARE_SIDE', ['roles.view', 'roles.edit', 'products.view']);
      const token = await userOnRoles('twohats', [adminRoleId, otherRoleId]);

      await api()
        .patch(`/api/v1/roles/${adminRoleId}`)
        .set('Authorization', bearer(token))
        .send({ permissionCodes: ['products.view'] })
        .expect(200);

      // Still an administrator, through the other role.
      const mine = await api().get('/api/v1/permissions/me').set('Authorization', bearer(token)).expect(200);
      expect(mine.body.data.permissions).toContain('roles.edit');
      await api().get('/api/v1/roles').set('Authorization', bearer(token)).expect(200);
    });

    it('refuses when the caller’s LAST source of administration is the role being edited', async () => {
      const onlyRoleId = await customRole('ONLY_ADMIN', ['roles.view', 'roles.edit', 'products.view']);
      const token = await userOnRoles('onehat', [onlyRoleId]);
      await api()
        .patch(`/api/v1/roles/${onlyRoleId}`)
        .set('Authorization', bearer(token))
        .send({ permissionCodes: ['products.view'] })
        .expect(409);
      // Unharmed.
      await api().get('/api/v1/roles').set('Authorization', bearer(token)).expect(200);
    });
  });

  // ================================================================
  // 3. System roles: renaming refused, permissions still editable
  // ================================================================
  describe('system roles', () => {
    it('refuses to RENAME a built-in template', async () => {
      const role = (await roles()).find((r) => r.name === 'CASHIER')!;
      expect(role.isSystem).toBe(true);
      const res = await api().patch(`/api/v1/roles/${role.id}`).set('Authorization', auth()).send({ name: 'Till Operator' }).expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toMatch(/cannot be renamed/i);
    });

    it('leaves the original name unchanged after a refused rename', async () => {
      const after = (await roles()).find((r) => r.isSystem && r.name === 'CASHIER');
      expect(after).toBeDefined();
      const row = await admin.role.findFirstOrThrow({ where: { id: after!.id } });
      expect(row.name).toBe('CASHIER');
    });

    it('STILL allows editing a built-in template’s permission set — decision B', async () => {
      // A tenant may legitimately decide their Cashier should not read
      // stock. Decision B keeps that open; only the NAME is fixed.
      const role = (await roles()).find((r) => r.name === 'CASHIER')!;
      const trimmed = codesOf(role).filter((c) => c !== 'inventory.view');
      expect(trimmed.length).toBeLessThan(codesOf(role).length);

      await api().patch(`/api/v1/roles/${role.id}`).set('Authorization', auth()).send({ permissionCodes: trimmed }).expect(200);

      const after = (await roles()).find((r) => r.id === role.id)!;
      expect(codesOf(after)).not.toContain('inventory.view');
      // Put it back, so later cases see the seeded matrix.
      await api().patch(`/api/v1/roles/${role.id}`).set('Authorization', auth()).send({ permissionCodes: codesOf(role) }).expect(200);
    });

    it('renames a CUSTOM role freely — the restriction is `isSystem`, not roles in general', async () => {
      const id = await customRole('RENAME_ME', ['products.view']);
      await api().patch(`/api/v1/roles/${id}`).set('Authorization', auth()).send({ name: 'RENAMED' }).expect(200);
      expect((await roles()).find((r) => r.id === id)!.name).toBe('RENAMED');
    });
  });

  // ================================================================
  // 4. Everything the fix must NOT have changed
  // ================================================================
  describe('existing protections are intact', () => {
    it('still refuses to delete a built-in template', async () => {
      const role = (await roles()).find((r) => r.isSystem)!;
      const res = await api().delete(`/api/v1/roles/${role.id}`).set('Authorization', auth()).expect(409);
      expect(res.body.error.message).toMatch(/cannot be deleted/i);
    });

    it('still refuses to delete a role that is assigned to someone', async () => {
      const id = await customRole('ASSIGNED', ['products.view']);
      await userOnRoles('assignee', [id]);
      const res = await api().delete(`/api/v1/roles/${id}`).set('Authorization', auth()).expect(409);
      expect(res.body.error.message).toMatch(/still assigned/i);
    });

    it('still deletes an unassigned custom role', async () => {
      const id = await customRole('DISPOSABLE', ['products.view']);
      await api().delete(`/api/v1/roles/${id}`).set('Authorization', auth()).expect(200);
      expect((await roles()).find((r) => r.id === id)).toBeUndefined();
    });

    it('still refuses to strip or suspend the last active Business Owner', async () => {
      const users = await api().get('/api/v1/users').set('Authorization', auth()).expect(200);
      const owner = users.body.data.find((u: { email: string }) => u.email === biz.ownerEmail);
      const spare = await customRole('SPARE_FOR_OWNER', ['products.view']);

      for (const body of [{ status: 'SUSPENDED' }, { roleIds: [spare] }]) {
        const res = await api().patch(`/api/v1/users/${owner.id}`).set('Authorization', auth()).send(body).expect(409);
        expect(res.body.error.message).toMatch(/last active Business Owner/i);
      }
      await api().delete(`/api/v1/users/${owner.id}`).set('Authorization', auth()).expect(409);
    });

    it('still validates permission codes and role names', async () => {
      const role = await ownerRole();
      await api()
        .patch(`/api/v1/roles/${role.id}`)
        .set('Authorization', auth())
        .send({ permissionCodes: ['not.a.real.permission'] })
        .expect(422);
      const custom = await customRole('DUPE_TARGET', ['products.view']);
      await api().patch(`/api/v1/roles/${custom}`).set('Authorization', auth()).send({ name: 'BUSINESS_OWNER' }).expect(409);
    });

    it('still isolates roles across tenants — including the new guards', async () => {
      const theirs = await roles(other.accessToken);
      const theirOwner = theirs.find((r) => r.name === 'BUSINESS_OWNER')!;
      // A foreign role 404s before either guard is even reached, so the
      // fix cannot be used to probe another tenant's role structure.
      await api().patch(`/api/v1/roles/${theirOwner.id}`).set('Authorization', auth()).send({ name: 'Hijacked' }).expect(404);
      await api()
        .patch(`/api/v1/roles/${theirOwner.id}`)
        .set('Authorization', auth())
        .send({ permissionCodes: ['products.view'] })
        .expect(404);
      await api().delete(`/api/v1/roles/${theirOwner.id}`).set('Authorization', auth()).expect(404);

      const stillTheirs = (await roles(other.accessToken)).find((r) => r.id === theirOwner.id)!;
      expect(stillTheirs.name).toBe('BUSINESS_OWNER');
      expect(codesOf(stillTheirs).length).toBe(codesOf(theirOwner).length);
    });

    it('records every accepted role change in the audit log, with before and after', async () => {
      const id = await customRole('AUDITED', ['products.view']);
      await api().patch(`/api/v1/roles/${id}`).set('Authorization', auth()).send({ permissionCodes: ['products.view', 'customers.view'] }).expect(200);
      const log = await api().get(`/api/v1/audit-logs?entityType=Role&entityId=${id}`).set('Authorization', auth()).expect(200);
      const update = log.body.data.find((r: { action: string }) => r.action === 'UPDATE');
      expect(update.before.permissionCodes).toEqual(['products.view']);
      expect(update.after.permissionCodes.sort()).toEqual(['customers.view', 'products.view']);
    });
  });
});
