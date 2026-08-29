import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupInventoryFixture, createSimpleProduct, InventoryFixture } from './utils/inventory-fixtures';

describe('Sales: shifts (e2e, real Postgres)', () => {
  let app: INestApplication;
  let biz: InventoryFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    biz = await setupInventoryFixture(app, 'sales-shifts');
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  it('has no active shift initially, opens one, and reports it as active', async () => {
    const before = await request(app.getHttpServer()).get('/api/v1/sales/shifts/active').set('Authorization', auth()).expect(200);
    expect(before.body.data).toBeNull();

    const opened = await request(app.getHttpServer())
      .post('/api/v1/sales/shifts/open')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId })
      .expect(201);
    expect(opened.body.data.status).toBe('OPEN');

    const active = await request(app.getHttpServer()).get('/api/v1/sales/shifts/active').set('Authorization', auth()).expect(200);
    expect(active.body.data.id).toBe(opened.body.data.id);

    await request(app.getHttpServer()).post('/api/v1/sales/shifts/close').set('Authorization', auth()).expect(200);
  });

  it('rejects opening a second shift while one is already open (app pre-check AND DB partial unique index)', async () => {
    await request(app.getHttpServer()).post('/api/v1/sales/shifts/open').set('Authorization', auth()).send({ warehouseId: biz.warehouseId }).expect(201);

    const second = await request(app.getHttpServer())
      .post('/api/v1/sales/shifts/open')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId })
      .expect(409);
    expect(second.body.error.code).toBe('CONFLICT');

    await request(app.getHttpServer()).post('/api/v1/sales/shifts/close').set('Authorization', auth()).expect(200);
  });

  it('rejects closing when there is no open shift', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/sales/shifts/close').set('Authorization', auth()).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects opening a shift against an unknown warehouse', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales/shifts/open')
      .set('Authorization', auth())
      .send({ warehouseId: '00000000-0000-0000-0000-000000000000' })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('INVARIANT: a sale cannot be completed without an active shift', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SHIFT-INVARIANT-1', { defaultSellingPrice: 10 });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 10, unitCost: 5 })
      .expect(201);

    // No shift open at this point (previous test's shift-close left none open).
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        items: [{ variantId, quantity: 1, unitPrice: 10 }],
        payments: [{ amount: 10, method: 'CASH' }],
      })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});
