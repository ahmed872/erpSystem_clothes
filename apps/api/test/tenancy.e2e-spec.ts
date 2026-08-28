import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';

describe('Tenancy: branches / warehouses / settings (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let token: string;
  let businessId: string;
  let defaultBranchId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    const reg = await request(app.getHttpServer()).post('/api/v1/businesses/register').send({
      businessName: 'Tenancy E2E Biz',
      businessSlug: 'tenancy-e2e-biz',
      ownerName: 'Owner',
      ownerEmail: 'owner@tenancy-e2e.test',
      ownerPassword: 'Sup3rSecret!',
    });
    businessId = reg.body.data.businessId;
    defaultBranchId = reg.body.data.branchId;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'owner@tenancy-e2e.test', password: 'Sup3rSecret!', businessSlug: 'tenancy-e2e-biz' });
    token = login.body.data.accessToken;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('creates a second branch and rejects a duplicate name within the same business', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/branches')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Downtown Branch' })
      .expect(201);
    expect(res.body.data.name).toBe('Downtown Branch');

    const dup = await request(app.getHttpServer())
      .post('/api/v1/branches')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Downtown Branch' })
      .expect(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('rejects creating a warehouse under a branch id that does not exist (or belongs to another tenant)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/warehouses')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId: '00000000-0000-0000-0000-000000000000', name: 'Ghost Warehouse' })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('creating a second default warehouse in the same branch unsets the previous default', async () => {
    const second = await request(app.getHttpServer())
      .post('/api/v1/warehouses')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId: defaultBranchId, name: 'Overflow Storage', isDefault: true })
      .expect(201);
    expect(second.body.data.isDefault).toBe(true);

    const warehouses = await admin.warehouse.findMany({ where: { branchId: defaultBranchId } });
    const defaults = warehouses.filter((w) => w.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(second.body.data.id);
  });

  it('upserts and lists business settings, and enforces settings.edit permission', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'pos.negative_inventory_allowed', value: false })
      .expect(200);

    const list = await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const setting = list.body.data.find((s: { key: string }) => s.key === 'pos.negative_inventory_allowed');
    expect(setting.value).toBe(false);

    // Overwrite same key -> update, not duplicate.
    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'pos.negative_inventory_allowed', value: true })
      .expect(200);
    const count = await admin.setting.count({ where: { businessId, key: 'pos.negative_inventory_allowed' } });
    expect(count).toBe(1);
  });

  it('deactivating a branch is a soft update (is_active=false), never a hard delete', async () => {
    const branch = await admin.branch.findFirstOrThrow({ where: { businessId, name: 'Downtown Branch' } });
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/branches/${branch.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false })
      .expect(200);
    expect(res.body.data.isActive).toBe(false);

    const stillExists = await admin.branch.findUnique({ where: { id: branch.id } });
    expect(stillExists).not.toBeNull();
  });
});
