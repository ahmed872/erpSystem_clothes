import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';

describe('RBAC / permissions (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let businessId: string;
  let ownerToken: string;
  let ownerUserId: string;

  const slug = 'rbac-e2e-biz';
  const ownerEmail = 'owner@rbac-e2e.test';
  const password = 'Sup3rSecret!';

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    const reg = await request(app.getHttpServer()).post('/api/v1/businesses/register').send({
      businessName: 'RBAC E2E Biz',
      businessSlug: slug,
      ownerName: 'Owner',
      ownerEmail,
      ownerPassword: password,
    });
    businessId = reg.body.data.businessId;
    ownerUserId = reg.body.data.ownerUserId;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ownerEmail, password, businessSlug: slug });
    ownerToken = login.body.data.accessToken;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('rejects any request without a bearer token with 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/branches').expect(401);
  });

  it('a Cashier (limited permissions) is forbidden from creating a branch (403), server-side, not just UI-hidden', async () => {
    const cashierRole = await admin.role.findFirstOrThrow({ where: { businessId, name: 'CASHIER' } });
    const branch = await admin.branch.findFirstOrThrow({ where: { businessId } });

    const createCashier = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Casey Cashier',
        email: 'cashier@rbac-e2e.test',
        password: 'CashierPass1!',
        roleIds: [cashierRole.id],
        branchIds: [branch.id],
      })
      .expect(201);
    expect(createCashier.body.data.email).toBe('cashier@rbac-e2e.test');
    expect(createCashier.body.data.passwordHash).toBeUndefined();

    const cashierLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'cashier@rbac-e2e.test', password: 'CashierPass1!', businessSlug: slug })
      .expect(200);
    const cashierToken = cashierLogin.body.data.accessToken;

    // Cashier CAN view branches (default template grant)...
    await request(app.getHttpServer())
      .get('/api/v1/branches')
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(200);

    // ...but CANNOT create one - the guard must reject at the API layer.
    const forbidden = await request(app.getHttpServer())
      .post('/api/v1/branches')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ name: 'Should Not Be Created' })
      .expect(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');

    const branchesAfter = await admin.branch.count({ where: { businessId } });
    expect(branchesAfter).toBe(1); // only the onboarding default branch
  });

  it('revoking a permission via role update takes effect on the very next request (no stale JWT cache)', async () => {
    const branchManagerRole = await admin.role.findFirstOrThrow({ where: { businessId, name: 'BRANCH_MANAGER' } });

    const bm = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Manny Manager',
        email: 'manager@rbac-e2e.test',
        password: 'ManagerPass1!',
        roleIds: [branchManagerRole.id],
      })
      .expect(201);

    const bmLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'manager@rbac-e2e.test', password: 'ManagerPass1!', businessSlug: slug })
      .expect(200);
    const bmToken = bmLogin.body.data.accessToken;

    await request(app.getHttpServer())
      .get('/api/v1/warehouses')
      .set('Authorization', `Bearer ${bmToken}`)
      .expect(200);

    // Owner strips the BRANCH_MANAGER role of warehouses.view.
    await request(app.getHttpServer())
      .patch(`/api/v1/roles/${branchManagerRole.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ permissionCodes: ['branches.view'] })
      .expect(200);

    // Same still-unexpired access token, but the permission is gone now.
    await request(app.getHttpServer())
      .get('/api/v1/warehouses')
      .set('Authorization', `Bearer ${bmToken}`)
      .expect(403);

    void bm;
  });

  it('cannot suspend or de-own the last active Business Owner (lockout guard)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/users/${ownerUserId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'SUSPENDED' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');

    const owner = await admin.user.findUniqueOrThrow({ where: { id: ownerUserId } });
    expect(owner.status).toBe('ACTIVE');
  });

  it('cannot delete a role that still has assigned users', async () => {
    const cashierRole = await admin.role.findFirstOrThrow({ where: { businessId, name: 'CASHIER' } });
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/roles/${cashierRole.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('cannot delete a built-in system role template even when unused', async () => {
    const salesRole = await admin.role.findFirstOrThrow({ where: { businessId, name: 'SALES_EMPLOYEE' } });
    await request(app.getHttpServer())
      .delete(`/api/v1/roles/${salesRole.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);
  });
});
