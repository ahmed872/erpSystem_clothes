import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';

/**
 * Phase 20 (Decision B) — THE ROLES SCREEN CANNOT BE EDITED SHUT.
 *
 * Phase 20 gives the administration UI a real role editor, which makes an
 * irreversible mistake reachable for the first time: clear `roles.view` or
 * `roles.edit` from the role you are signed in through and nobody in the
 * business can open the roles screen again. There is no break-glass path
 * in the product.
 *
 * These tests prove the refusal is the SERVER'S, by calling the API
 * directly rather than through any screen, and prove the four things
 * Decision B kept open stayed open:
 *
 *   1. custom roles remain editable (name and permissions)
 *   2. system roles remain permission-editable
 *   3. system roles cannot be renamed
 *   4. the last-owner protections are untouched (rbac.e2e-spec.ts)
 *
 * and that the guard is scoped honestly: a role the caller does NOT hold
 * can still have role administration removed, because doing so locks
 * nobody out of anything.
 */
describe('Phase 20 Decision B: role administration lockout (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let businessId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let ownerRoleId: string;
  let branchId: string;
  let allPermissionCodes: string[];

  const slug = 'decision-b-e2e-biz';
  const ownerEmail = 'owner@decision-b.test';
  const password = 'Sup3rSecret!';

  /** Every code the owner template holds — the starting point for "the
   *  same set, minus one". */
  async function codesOfRole(roleId: string): Promise<string[]> {
    const rows = await admin.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { code: true } } },
    });
    return rows.map((r) => r.permission.code).sort();
  }

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    const reg = await request(app.getHttpServer()).post('/api/v1/businesses/register').send({
      businessName: 'Decision B Biz',
      businessSlug: slug,
      ownerName: 'Owner',
      ownerEmail,
      ownerPassword: password,
    });
    businessId = reg.body.data.businessId;
    ownerUserId = reg.body.data.ownerUserId;
    branchId = reg.body.data.branchId;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ownerEmail, password, businessSlug: slug })
      .expect(200);
    ownerToken = login.body.data.accessToken;

    const ownerRole = await admin.role.findFirstOrThrow({ where: { businessId, name: 'BUSINESS_OWNER' } });
    ownerRoleId = ownerRole.id;
    allPermissionCodes = await codesOfRole(ownerRoleId);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${ownerToken}`;

  // ------------------------------------------------------------------
  // Rule 3 — the lockout itself
  // ------------------------------------------------------------------

  it.each(['roles.view', 'roles.edit'])(
    'refuses to remove %s from a role the caller actually holds, and writes nothing',
    async (code) => {
      const before = await codesOfRole(ownerRoleId);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/roles/${ownerRoleId}`)
        .set('Authorization', auth())
        .send({ permissionCodes: before.filter((c) => c !== code) })
        .expect(409);

      expect(res.body.error.code).toBe('CONFLICT');
      // The whole transaction rolls back: the role is byte-for-byte what
      // it was, not "mostly" what it was.
      expect(await codesOfRole(ownerRoleId)).toEqual(before);
    },
  );

  it('refuses when BOTH role-administration codes are removed at once, naming both', async () => {
    const before = await codesOfRole(ownerRoleId);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/roles/${ownerRoleId}`)
      .set('Authorization', auth())
      .send({ permissionCodes: before.filter((c) => c !== 'roles.view' && c !== 'roles.edit') })
      .expect(409);

    expect(res.body.error.details.removedPermissionCodes.sort()).toEqual(['roles.edit', 'roles.view']);
    expect(await codesOfRole(ownerRoleId)).toEqual(before);
  });

  it('the refusal survives the caller reaching the endpoint directly — it is not a hidden button', async () => {
    // Same call, no Referer, no browser, no UI state. The API is the
    // authority and answers identically.
    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${ownerRoleId}`)
      .set('Authorization', auth())
      .send({ permissionCodes: ['products.view'] })
      .expect(409);
  });

  it('still allows removing an UNRELATED permission from a role the caller holds', async () => {
    const before = await codesOfRole(ownerRoleId);
    expect(before).toContain('products.view');

    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${ownerRoleId}`)
      .set('Authorization', auth())
      .send({ permissionCodes: before.filter((c) => c !== 'products.view') })
      .expect(200);

    expect(await codesOfRole(ownerRoleId)).not.toContain('products.view');

    // Put it back — later assertions in this file read the owner template.
    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${ownerRoleId}`)
      .set('Authorization', auth())
      .send({ permissionCodes: before })
      .expect(200);
    expect(await codesOfRole(ownerRoleId)).toEqual(before);
  });

  it('allows removing role administration from a role the caller does NOT hold', async () => {
    // Nobody is locked out by this: the caller keeps their own grant, and
    // the guard is about lockout, not about protecting the codes in the
    // abstract.
    const created = await request(app.getHttpServer())
      .post('/api/v1/roles')
      .set('Authorization', auth())
      .send({ name: 'AUDITOR_UNHELD', permissionCodes: ['roles.view', 'roles.edit', 'audit.view'] })
      .expect(201);
    const roleId = created.body.data.id as string;

    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${roleId}`)
      .set('Authorization', auth())
      .send({ permissionCodes: ['audit.view'] })
      .expect(200);

    expect(await codesOfRole(roleId)).toEqual(['audit.view']);
  });

  it('fires for a NON-owner caller too: the check is the caller\'s own role assignment, never a role name', async () => {
    const roleName = 'ROLE_ADMIN_ONLY';
    const created = await request(app.getHttpServer())
      .post('/api/v1/roles')
      .set('Authorization', auth())
      .send({ name: roleName, permissionCodes: ['roles.view', 'roles.edit'] })
      .expect(201);
    const roleId = created.body.data.id as string;

    const email = 'roleadmin@decision-b.test';
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: 'Role Admin', email, password: 'RoleAdmin1!', roleIds: [roleId], branchIds: [branchId] })
      .expect(201);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'RoleAdmin1!', businessSlug: slug })
      .expect(200);
    const token = login.body.data.accessToken as string;

    // This caller is not an owner and holds nothing else. Stripping
    // `roles.edit` from their only role would end role administration for
    // them permanently.
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/roles/${roleId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ permissionCodes: ['roles.view'] })
      .expect(409);
    expect(res.body.error.details.removedPermissionCodes).toEqual(['roles.edit']);

    expect(await codesOfRole(roleId)).toEqual(['roles.edit', 'roles.view']);
  });

  it('lets a caller ADD role administration to a role they hold', async () => {
    const roleName = 'GROWING_ROLE';
    const created = await request(app.getHttpServer())
      .post('/api/v1/roles')
      .set('Authorization', auth())
      .send({ name: roleName, permissionCodes: ['roles.view', 'roles.edit'] })
      .expect(201);
    const roleId = created.body.data.id as string;

    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${roleId}`)
      .set('Authorization', auth())
      .send({ permissionCodes: ['roles.view', 'roles.edit', 'audit.view'] })
      .expect(200);

    expect(await codesOfRole(roleId)).toEqual(['audit.view', 'roles.edit', 'roles.view']);
  });

  // ------------------------------------------------------------------
  // Rules 1, 2 and 4 — what stayed open, and what closed
  // ------------------------------------------------------------------

  it('rule 4: a system role cannot be renamed, and the rename does not partially apply', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/roles/${ownerRoleId}`)
      .set('Authorization', auth())
      .send({ name: 'OWNER_RENAMED' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');

    const role = await admin.role.findUniqueOrThrow({ where: { id: ownerRoleId } });
    expect(role.name).toBe('BUSINESS_OWNER');
  });

  it('rule 4: a rename bundled with a legal permission change is refused WHOLE', async () => {
    const cashierRole = await admin.role.findFirstOrThrow({ where: { businessId, name: 'CASHIER' } });
    const before = await codesOfRole(cashierRole.id);

    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${cashierRole.id}`)
      .set('Authorization', auth())
      .send({ name: 'TILL_OPERATOR', permissionCodes: [...before, 'audit.view'] })
      .expect(409);

    const after = await admin.role.findUniqueOrThrow({ where: { id: cashierRole.id } });
    expect(after.name).toBe('CASHIER');
    expect(await codesOfRole(cashierRole.id)).toEqual(before);
  });

  it('rule 4: sending a system role its OWN name is not a rename and is accepted', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${ownerRoleId}`)
      .set('Authorization', auth())
      .send({ name: 'BUSINESS_OWNER' })
      .expect(200);
  });

  it('rule 2: a system role remains permission-editable', async () => {
    const cashierRole = await admin.role.findFirstOrThrow({ where: { businessId, name: 'CASHIER' } });
    const before = await codesOfRole(cashierRole.id);
    expect(before).not.toContain('audit.view');

    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${cashierRole.id}`)
      .set('Authorization', auth())
      .send({ permissionCodes: [...before, 'audit.view'] })
      .expect(200);

    expect(await codesOfRole(cashierRole.id)).toContain('audit.view');
  });

  it('rule 1: a custom role remains fully editable, name included', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/roles')
      .set('Authorization', auth())
      .send({ name: 'STOCKTAKER', permissionCodes: ['inventory.view'] })
      .expect(201);
    const roleId = created.body.data.id as string;
    expect(created.body.data.isSystem).toBe(false);

    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${roleId}`)
      .set('Authorization', auth())
      .send({ name: 'STOCK_TAKER', permissionCodes: ['inventory.view', 'products.view'] })
      .expect(200);

    const role = await admin.role.findUniqueOrThrow({ where: { id: roleId } });
    expect(role.name).toBe('STOCK_TAKER');
    expect(await codesOfRole(roleId)).toEqual(['inventory.view', 'products.view']);
  });

  // ------------------------------------------------------------------
  // The guard does not become a new way in
  // ------------------------------------------------------------------

  it('a caller without roles.edit is still refused with 403, before any of this is reached', async () => {
    const cashierRole = await admin.role.findFirstOrThrow({ where: { businessId, name: 'CASHIER' } });
    const email = 'cashier@decision-b.test';
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: 'Casey', email, password: 'CashierPass1!', roleIds: [cashierRole.id], branchIds: [branchId] })
      .expect(201);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'CashierPass1!', businessSlug: slug })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${cashierRole.id}`)
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .send({ permissionCodes: ['products.view'] })
      .expect(403);
  });

  it('is tenant-scoped: another business\'s role is a 404, not a 409', async () => {
    const otherSlug = `${slug}-other`;
    const otherEmail = `owner@${otherSlug}.test`;
    await request(app.getHttpServer())
      .post('/api/v1/businesses/register')
      .send({
        businessName: 'Decision B Other',
        businessSlug: otherSlug,
        ownerName: 'Other Owner',
        ownerEmail: otherEmail,
        ownerPassword: password,
      })
      .expect(201);

    const otherBusiness = await admin.business.findFirstOrThrow({ where: { slug: otherSlug } });
    const otherOwnerRole = await admin.role.findFirstOrThrow({
      where: { businessId: otherBusiness.id, name: 'BUSINESS_OWNER' },
    });
    const before = await codesOfRole(otherOwnerRole.id);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/roles/${otherOwnerRole.id}`)
      .set('Authorization', auth())
      .send({ permissionCodes: ['products.view'] })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    // Untouched, and still the other tenant's.
    expect(await codesOfRole(otherOwnerRole.id)).toEqual(before);
  });

  it('the owner is still the owner at the end of all this', async () => {
    // A guard that quietly cost the caller a permission would be worse
    // than the lockout it prevents.
    const me = await request(app.getHttpServer())
      .get('/api/v1/permissions/me')
      .set('Authorization', auth())
      .expect(200);
    expect(me.body.data.permissions).toEqual(expect.arrayContaining(['roles.view', 'roles.edit']));
    expect(await admin.userRole.count({ where: { userId: ownerUserId, roleId: ownerRoleId } })).toBe(1);
    expect(allPermissionCodes.length).toBeGreaterThan(0);
  });
});
