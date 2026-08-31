import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { ROLE_TEMPLATE_PERMISSIONS, ROLE_TEMPLATES, PERMISSION_CODES, type RoleTemplate } from '@retail/shared-types';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { registerAndLogin, RegisteredBusiness } from './utils/register-and-login';

/**
 * Phase 12 BLOCKING-A — GET /permissions/me.
 *
 * The frontend (ERP web + POS web) needs to know what nav/routes/actions
 * to show for whoever is actually signed in, without the global 117-code
 * catalogue (`GET /permissions`, gated on `permissions.view` - a
 * permission NONE of the POS-selling roles hold) and without recomputing
 * authorization client-side. This proves the new endpoint: identifies the
 * caller from the JWT alone, is tenant-scoped, returns exactly the
 * effective set for every approved role including Cashier, cannot be used
 * to ask about anyone else, and never becomes a substitute for the real
 * per-endpoint permission checks it sits alongside.
 */
describe('Phase 12 BLOCKING-A: GET /permissions/me (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: RegisteredBusiness;
  let other: RegisteredBusiness;
  let seq = 0;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await registerAndLogin(app, 'perm-me');
    other = await registerAndLogin(app, 'perm-me-other');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  /** A fresh user on `biz` holding exactly one role template, logged in. */
  async function makeUser(roleName: RoleTemplate) {
    const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: roleName } });
    const email = `permme${seq++}@${biz.slug}.test`;
    const password = 'RoleUserPass1!';
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .send({ name: `permme ${roleName}`, email, password, roleIds: [role.id], branchIds: [] })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, businessSlug: biz.slug })
      .expect(200);
    return {
      id: created.body.data.id as string,
      email,
      password,
      accessToken: login.body.data.accessToken as string,
    };
  }

  const getMe = (token: string) => request(app.getHttpServer()).get('/api/v1/permissions/me').set('Authorization', `Bearer ${token}`);

  it('rejects an unauthenticated request with 401 — remains subject to the existing auth guard', async () => {
    await request(app.getHttpServer()).get('/api/v1/permissions/me').expect(401);
  });

  it('does NOT require permissions.view, unlike the global catalogue it sits beside', async () => {
    const cashier = await makeUser('CASHIER');
    // The catalogue is gated and a Cashier does not hold permissions.view.
    const catalogue = await getMe(cashier.accessToken); // placeholder to keep token warm
    void catalogue;
    await request(app.getHttpServer())
      .get('/api/v1/permissions')
      .set('Authorization', `Bearer ${cashier.accessToken}`)
      .expect(403);

    // But the caller's own effective set is readable regardless.
    await getMe(cashier.accessToken).expect(200);
  });

  it('never returns the global 117-code catalogue, only the caller\'s own effective set', async () => {
    const cashier = await makeUser('CASHIER');
    const res = await getMe(cashier.accessToken).expect(200);
    const permissions: string[] = res.body.data.permissions;
    expect(permissions.length).toBeLessThan(PERMISSION_CODES.length);
    expect(permissions.length).toBe(ROLE_TEMPLATE_PERMISSIONS.CASHIER.length);
  });

  it.each(ROLE_TEMPLATES)('%s receives exactly its own effective permission set — nothing more, nothing less', async (roleName) => {
    const user = roleName === 'BUSINESS_OWNER' ? { accessToken: biz.accessToken } : await makeUser(roleName);
    const res = await getMe(user.accessToken).expect(200);
    const permissions: string[] = res.body.data.permissions;
    const expected = [...ROLE_TEMPLATE_PERMISSIONS[roleName]].sort();
    expect(permissions).toEqual(expected);
  });

  it('Owner receives every permission that exists (its template is the full catalogue)', async () => {
    const res = await getMe(biz.accessToken).expect(200);
    expect(res.body.data.permissions).toEqual([...PERMISSION_CODES].sort());
  });

  it('is tenant-scoped: the same role template differs across tenants when roles diverge', async () => {
    // Owner B strips warehouses.view from its BRANCH_MANAGER template.
    const bmRoleB = await admin.role.findFirstOrThrow({ where: { businessId: other.businessId, name: 'BRANCH_MANAGER' } });
    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${bmRoleB.id}`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .send({ permissionCodes: ['branches.view'] })
      .expect(200);

    const emailB = `permme-bm@${other.slug}.test`;
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${other.accessToken}`)
      .send({ name: 'BM B', email: emailB, password: 'RoleUserPass1!', roleIds: [bmRoleB.id], branchIds: [] })
      .expect(201);
    const loginB = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: emailB, password: 'RoleUserPass1!', businessSlug: other.slug })
      .expect(200);

    const bmA = await makeUser('BRANCH_MANAGER');
    const resA = await getMe(bmA.accessToken).expect(200);
    const resB = await getMe(loginB.body.data.accessToken).expect(200);

    expect(resA.body.data.permissions).toEqual([...ROLE_TEMPLATE_PERMISSIONS.BRANCH_MANAGER].sort());
    expect(resB.body.data.permissions).toEqual(['branches.view']);
  });

  it('reflects a permission change on the very next request (no stale snapshot)', async () => {
    const branchManagerRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'BRANCH_MANAGER' } });
    const bm = await makeUser('BRANCH_MANAGER');

    const before = await getMe(bm.accessToken).expect(200);
    expect(before.body.data.permissions).toContain('warehouses.view');

    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${branchManagerRole.id}`)
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .send({ permissionCodes: ['branches.view'] })
      .expect(200);

    const after = await getMe(bm.accessToken).expect(200);
    expect(after.body.data.permissions).toEqual(['branches.view']);

    // Restore the template for the tests that follow.
    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${branchManagerRole.id}`)
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .send({ permissionCodes: ROLE_TEMPLATE_PERMISSIONS.BRANCH_MANAGER })
      .expect(200);
  });

  it('cross-tenant impersonation is impossible: a query/body userId is ignored, never another tenant\'s data', async () => {
    const cashierA = await makeUser('CASHIER');
    const withForeignUserId = await request(app.getHttpServer())
      .get(`/api/v1/permissions/me?userId=${other.ownerUserId}`)
      .set('Authorization', `Bearer ${cashierA.accessToken}`)
      .expect(200);
    // No user-id input exists on this route at all — the caller's own set
    // comes back regardless of anything supplied in the query string.
    expect(withForeignUserId.body.data.permissions).toEqual([...ROLE_TEMPLATE_PERMISSIONS.CASHIER].sort());
  });

  it('cannot be used to enumerate another user\'s permissions within the same tenant', async () => {
    const cashierA = await makeUser('CASHIER');
    const accountantA = await makeUser('ACCOUNTANT');

    const asCashier = await getMe(cashierA.accessToken).expect(200);
    const asAccountant = await getMe(accountantA.accessToken).expect(200);

    // Each caller sees only their OWN set — trying to pass the other
    // user's id, email, or token has no effect other than as a bearer
    // token, which each already only holds for themselves.
    expect(asCashier.body.data.permissions).not.toEqual(asAccountant.body.data.permissions);
    expect(asCashier.body.data.permissions).toEqual([...ROLE_TEMPLATE_PERMISSIONS.CASHIER].sort());
    expect(asAccountant.body.data.permissions).toEqual([...ROLE_TEMPLATE_PERMISSIONS.ACCOUNTANT].sort());
  });

  it('does not expose unnecessary user/account information — the payload is permissions only', async () => {
    const cashier = await makeUser('CASHIER');
    const res = await getMe(cashier.accessToken).expect(200);
    expect(Object.keys(res.body.data)).toEqual(['permissions']);
    expect(res.body.data.passwordHash).toBeUndefined();
    expect(res.body.data.email).toBeUndefined();
    expect(res.body.data.userId).toBeUndefined();
  });

  it('a suspended user is rejected here exactly as the guard rejects it everywhere else', async () => {
    const cashier = await makeUser('CASHIER');
    await getMe(cashier.accessToken).expect(200);

    await request(app.getHttpServer())
      .delete(`/api/v1/users/${cashier.id}`)
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .expect(200);

    await getMe(cashier.accessToken).expect(401);
  });

  it('this endpoint never replaces real backend authorization: a listed permission still faces its own guard', async () => {
    const cashier = await makeUser('CASHIER');
    const res = await getMe(cashier.accessToken).expect(200);
    expect(res.body.data.permissions).not.toContain('accounting.journal.view');
    expect(res.body.data.permissions).toContain('sales.create');

    // Believing (correctly) that they lack accounting access changes
    // nothing about the server actually enforcing it independently.
    await request(app.getHttpServer())
      .get('/api/v1/accounting/journal-entries')
      .set('Authorization', `Bearer ${cashier.accessToken}`)
      .expect(403);

    // And holding sales.create per this endpoint's own answer is exactly
    // what lets the same caller reach a sales.create-gated route (shift
    // list; a full sale needs an open shift and warehouse too, which is
    // BLOCKING-B's concern) rather than being turned away.
    await request(app.getHttpServer())
      .get('/api/v1/sales/shifts')
      .set('Authorization', `Bearer ${cashier.accessToken}`)
      .expect(200);
  });
});
