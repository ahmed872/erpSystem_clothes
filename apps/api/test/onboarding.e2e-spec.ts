import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';

describe('Business onboarding (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const validBody = {
    businessName: 'Acme Clothing',
    businessSlug: 'acme-clothing-e2e',
    ownerName: 'Sara Owner',
    ownerEmail: 'sara@acme-e2e.test',
    ownerPassword: 'Sup3rSecret!',
  };

  it('creates business + default branch + default warehouse + 6 role templates + owner user atomically', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/businesses/register').send(validBody).expect(201);

    const { businessId, branchId, warehouseId, ownerUserId } = res.body.data;
    expect(businessId).toBeTruthy();

    const business = await admin.business.findUnique({ where: { id: businessId } });
    expect(business?.slug).toBe('acme-clothing-e2e');

    const branch = await admin.branch.findUnique({ where: { id: branchId } });
    expect(branch?.businessId).toBe(businessId);

    const warehouse = await admin.warehouse.findUnique({ where: { id: warehouseId } });
    expect(warehouse?.isDefault).toBe(true);
    expect(warehouse?.branchId).toBe(branchId);

    const roles = await admin.role.findMany({ where: { businessId } });
    expect(roles.map((r) => r.name).sort()).toEqual(
      ['ACCOUNTANT', 'BRANCH_MANAGER', 'BUSINESS_OWNER', 'CASHIER', 'INVENTORY_MANAGER', 'SALES_EMPLOYEE'].sort(),
    );

    const owner = await admin.user.findUnique({
      where: { id: ownerUserId },
      include: { userRoles: { include: { role: true } }, userBranches: true },
    });
    expect(owner?.email).toBe('sara@acme-e2e.test');
    expect(owner?.passwordHash).not.toContain('Sup3rSecret!');
    expect(owner?.userRoles.some((ur) => ur.role.name === 'BUSINESS_OWNER')).toBe(true);
    expect(owner?.userBranches.some((ub) => ub.branchId === branchId)).toBe(true);

    const ownerRole = owner!.userRoles.find((ur) => ur.role.name === 'BUSINESS_OWNER')!.role;
    const ownerPermCount = await admin.rolePermission.count({ where: { roleId: ownerRole.id } });
    const totalPermCount = await admin.permission.count();
    expect(ownerPermCount).toBe(totalPermCount);

    const audit = await admin.auditLog.findFirst({ where: { businessId, entityType: 'Business', action: 'CREATE' } });
    expect(audit).not.toBeNull();
  });

  it('rejects a duplicate business slug with 409 CONFLICT and creates nothing extra', async () => {
    const before = await admin.business.count();
    const res = await request(app.getHttpServer()).post('/api/v1/businesses/register').send(validBody).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
    const after = await admin.business.count();
    expect(after).toBe(before);
  });

  it('rejects a weak password with 422 VALIDATION_FAILED before touching the database', async () => {
    const before = await admin.business.count();
    const res = await request(app.getHttpServer())
      .post('/api/v1/businesses/register')
      .send({ ...validBody, businessSlug: 'weak-pw-biz', ownerEmail: 'weak@x.test', ownerPassword: 'short' })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const after = await admin.business.count();
    expect(after).toBe(before);
  });

  it('rejects an invalid slug format with 422', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/businesses/register')
      .send({ ...validBody, businessSlug: 'Not A Valid Slug!!' })
      .expect(422);
  });
});
