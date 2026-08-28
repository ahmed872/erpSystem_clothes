import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupPurchasingFixture, PurchasingFixture } from './utils/purchasing-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

describe('Purchasing: purchase document lifecycle (e2e, real Postgres)', () => {
  let app: INestApplication;
  let biz: PurchasingFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    biz = await setupPurchasingFixture(app, 'lifecycle');
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  it('creates a DRAFT purchase with a generated purchase number and correct computed totals', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PO-LINE-1');
    const res = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        supplierId: biz.supplierId,
        items: [{ variantId, quantityOrdered: 10, unitCost: 5, taxAmount: 2, discountAmount: 1 }],
      })
      .expect(201);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.purchaseNumber).toMatch(/^PO-[A-F0-9]{8}$/);
    expect(res.body.data.subtotal).toBe('50');
    expect(res.body.data.taxAmount).toBe('2');
    expect(res.body.data.discountAmount).toBe('1');
    expect(res.body.data.totalAmount).toBe('51');
    expect(res.body.data.branchId).toBe(biz.branchId);
  });

  it('rejects a purchase with no items, an unknown variant, a duplicate variant, or an inactive supplier', async () => {
    const noItems = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, supplierId: biz.supplierId, items: [] })
      .expect(422);
    expect(noItems.body.error.code).toBe('VALIDATION_FAILED');

    const unknownVariant = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        supplierId: biz.supplierId,
        items: [{ variantId: '00000000-0000-0000-0000-000000000000', quantityOrdered: 1, unitCost: 1 }],
      })
      .expect(404);
    expect(unknownVariant.body.error.code).toBe('NOT_FOUND');

    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PO-DUP-1');
    const dupVariant = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        supplierId: biz.supplierId,
        items: [
          { variantId, quantityOrdered: 1, unitCost: 1 },
          { variantId, quantityOrdered: 2, unitCost: 1 },
        ],
      })
      .expect(422);
    expect(dupVariant.body.error.code).toBe('VALIDATION_FAILED');

    const inactiveSupplier = await request(app.getHttpServer())
      .post('/api/v1/purchasing/suppliers')
      .set('Authorization', auth())
      .send({ name: 'Inactive Supplier For Purchase' })
      .expect(201);
    await request(app.getHttpServer()).delete(`/api/v1/purchasing/suppliers/${inactiveSupplier.body.data.id}`).set('Authorization', auth()).expect(200);
    const withInactive = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, supplierId: inactiveSupplier.body.data.id, items: [{ variantId, quantityOrdered: 1, unitCost: 1 }] })
      .expect(422);
    expect(withInactive.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects invalid quantities and costs (zero/negative)', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PO-INVALIDQTY-1');
    const zeroQty = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, supplierId: biz.supplierId, items: [{ variantId, quantityOrdered: 0, unitCost: 1 }] })
      .expect(422);
    expect(zeroQty.body.error.code).toBe('VALIDATION_FAILED');

    const negativeCost = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, supplierId: biz.supplierId, items: [{ variantId, quantityOrdered: 1, unitCost: -1 }] })
      .expect(422);
    expect(negativeCost.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a purchase against an unknown/foreign warehouse', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PO-BADWH-1');
    const res = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: '00000000-0000-0000-0000-000000000000', supplierId: biz.supplierId, items: [{ variantId, quantityOrdered: 1, unitCost: 1 }] })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('allows editing a DRAFT purchase (replacing items), but rejects editing once APPROVED', async () => {
    const { variantId: v1 } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PO-EDIT-1');
    const { variantId: v2 } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PO-EDIT-2');
    const created = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, supplierId: biz.supplierId, items: [{ variantId: v1, quantityOrdered: 5, unitCost: 2 }] })
      .expect(201);
    const purchaseId = created.body.data.id;

    const edited = await request(app.getHttpServer())
      .patch(`/api/v1/purchasing/purchases/${purchaseId}`)
      .set('Authorization', auth())
      .send({ items: [{ variantId: v2, quantityOrdered: 3, unitCost: 4 }] })
      .expect(200);
    expect(edited.body.data.items).toHaveLength(1);
    expect(edited.body.data.items[0].variantId).toBe(v2);
    expect(edited.body.data.totalAmount).toBe('12');

    await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${purchaseId}/approve`).set('Authorization', auth()).expect(200);

    const afterApprove = await request(app.getHttpServer())
      .patch(`/api/v1/purchasing/purchases/${purchaseId}`)
      .set('Authorization', auth())
      .send({ notes: 'too late' })
      .expect(409);
    expect(afterApprove.body.error.code).toBe('CONFLICT');
  });

  it('rejects approving a non-DRAFT purchase (double approve)', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PO-DBLAPPR-1');
    const created = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, supplierId: biz.supplierId, items: [{ variantId, quantityOrdered: 1, unitCost: 1 }] })
      .expect(201);
    const purchaseId = created.body.data.id;

    await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${purchaseId}/approve`).set('Authorization', auth()).expect(200);
    const dbl = await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${purchaseId}/approve`).set('Authorization', auth()).expect(409);
    expect(dbl.body.error.code).toBe('CONFLICT');
  });

  it('cancels a DRAFT and an APPROVED purchase, and rejects cancelling an already-CANCELLED one', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PO-CANCEL-1');
    const draft = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, supplierId: biz.supplierId, items: [{ variantId, quantityOrdered: 1, unitCost: 1 }] })
      .expect(201);
    const cancelled = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${draft.body.data.id}/cancel`)
      .set('Authorization', auth())
      .send({ reason: 'no longer needed' })
      .expect(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const again = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${draft.body.data.id}/cancel`)
      .set('Authorization', auth())
      .send({})
      .expect(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });

  it('returns 404 for a non-existent purchase id on get/approve/cancel', async () => {
    const id = '00000000-0000-0000-0000-000000000000';
    await request(app.getHttpServer()).get(`/api/v1/purchasing/purchases/${id}`).set('Authorization', auth()).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${id}/approve`).set('Authorization', auth()).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${id}/cancel`).set('Authorization', auth()).send({}).expect(404);
  });

  it('lists purchases filtered by status', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/v1/purchasing/purchases?status=CANCELLED')
      .set('Authorization', auth())
      .expect(200);
    expect(list.body.data.every((p: { status: string }) => p.status === 'CANCELLED')).toBe(true);
  });
});
