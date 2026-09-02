import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupInventoryFixture, createSimpleProduct, InventoryFixture } from './utils/inventory-fixtures';

describe('Inventory: adjustments and stock counts (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: InventoryFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupInventoryFixture(app, 'adjcounts');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  describe('Adjustments', () => {
    it('a positive adjustment (found stock) increases the balance using the current average cost', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ADJ-POS-1');
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 5 })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/inventory/adjustments')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 5, movementType: 'ADJUSTMENT', reason: 'Found extra units in back room' })
        .expect(201);
      expect(res.body.data.quantityOnHand).toBe('25');
      expect(res.body.data.averageCost).toBe('5'); // no new cost info -> stays at current avg
    });

    it('DAMAGE/LOSS/EXPIRY/INTERNAL_CONSUMPTION all decrease the balance and are individually distinguishable in the ledger', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ADJ-TYPES-1');
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 100, unitCost: 4 })
        .expect(201);

      for (const movementType of ['DAMAGE', 'LOSS', 'EXPIRY', 'INTERNAL_CONSUMPTION'] as const) {
        await request(app.getHttpServer())
          .post('/api/v1/inventory/adjustments')
          .set('Authorization', auth())
          .send({ warehouseId: biz.warehouseId, variantId, quantity: -5, movementType, reason: `${movementType} test` })
          .expect(201);
      }

      const movements = await admin.stockMovement.findMany({ where: { businessId: biz.businessId, variantId }, orderBy: { createdAt: 'asc' } });
      const types = movements.map((m) => m.movementType);
      expect(types).toEqual(expect.arrayContaining(['OPENING_BALANCE', 'DAMAGE', 'LOSS', 'EXPIRY', 'INTERNAL_CONSUMPTION']));

      const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
      expect(Number(balance.quantityOnHand)).toBe(80); // 100 - 5*4
    });

    it('rejects a negative adjustment that would take stock below zero, by default', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ADJ-NEG-1');
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 3, unitCost: 1 })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/inventory/adjustments')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: -10, movementType: 'DAMAGE', reason: 'too much' })
        .expect(409);
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    });
  });

  describe('Stock Counts', () => {
    it('full lifecycle: create -> submit items -> submit -> approve, generating adjustments against the LIVE balance', async () => {
      const { variantId: v1 } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'COUNT-V1');
      const { variantId: v2 } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'COUNT-V2');
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId: v1, quantity: 50, unitCost: 10 })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId: v2, quantity: 30, unitCost: 4 })
        .expect(201);

      const count = await request(app.getHttpServer())
        .post('/api/v1/inventory/stock-counts')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantIds: [v1, v2] })
        .expect(201);
      const countId = count.body.data.id;
      const v1Item = count.body.data.items.find((i: { variantId: string }) => i.variantId === v1);
      expect(v1Item.expectedQuantity).toBe('50');

      // Physical count: v1 has 48 (2 missing), v2 matches exactly at 30.
      await request(app.getHttpServer())
        .patch(`/api/v1/inventory/stock-counts/${countId}/items`)
        .set('Authorization', auth())
        .send({ items: [{ variantId: v1, actualQuantity: 48, reason: 'shrinkage' }, { variantId: v2, actualQuantity: 30 }] })
        .expect(200);

      await request(app.getHttpServer()).post(`/api/v1/inventory/stock-counts/${countId}/submit`).set('Authorization', auth()).expect(200);

      const approved = await request(app.getHttpServer())
        .post(`/api/v1/inventory/stock-counts/${countId}/approve`)
        .set('Authorization', auth())
        .expect(200);

      // Only v1 should have generated an adjustment (v2's count matched exactly).
      expect(approved.body.data.adjustments).toHaveLength(1);
      expect(approved.body.data.adjustments[0]).toMatchObject({ variantId: v1, delta: '-2' });

      const balV1 = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: v1 } });
      expect(Number(balV1.quantityOnHand)).toBe(48);
      const balV2 = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: v2 } });
      expect(Number(balV2.quantityOnHand)).toBe(30);
    });

    it('uses the LIVE balance at approval time, not the stale expected-quantity snapshot, when a sale happens mid-count', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'COUNT-LIVE-1');
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 100, unitCost: 10 })
        .expect(201);

      // Count created while balance is 100 (snapshot expectedQuantity=100).
      const count = await request(app.getHttpServer())
        .post('/api/v1/inventory/stock-counts')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantIds: [variantId] })
        .expect(201);
      const countId = count.body.data.id;
      expect(count.body.data.items[0].expectedQuantity).toBe('100');

      // A sale happens WHILE the count is still in progress (real-world:
      // another cashier sells 20 units before the count is approved).
      await request(app.getHttpServer())
        .post('/api/v1/inventory/consumptions')
        .set('Authorization', auth())
        .send({ referenceType: 'Sale', referenceId: 'fixture-sale', warehouseId: biz.warehouseId, variantId, quantity: 20 })
        .expect(201);
      // Live balance is now 80.

      // The physical counter (who started before the sale) still reports
      // what they physically counted: 100.
      await request(app.getHttpServer())
        .patch(`/api/v1/inventory/stock-counts/${countId}/items`)
        .set('Authorization', auth())
        .send({ items: [{ variantId, actualQuantity: 100 }] })
        .expect(200);
      await request(app.getHttpServer()).post(`/api/v1/inventory/stock-counts/${countId}/submit`).set('Authorization', auth()).expect(200);

      const approved = await request(app.getHttpServer())
        .post(`/api/v1/inventory/stock-counts/${countId}/approve`)
        .set('Authorization', auth())
        .expect(200);

      // Correct behavior: delta = 100 (counted) - 80 (live at approval) = +20.
      // NOT 100 - 100 (stale snapshot) = 0, which would silently discard
      // the concurrent sale's effect.
      expect(approved.body.data.adjustments[0]).toMatchObject({ variantId, delta: '20' });
      const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
      expect(Number(balance.quantityOnHand)).toBe(100);
    });

    it('rejects operations on a stock count in the wrong status', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'COUNT-STATUS-1');
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 10, unitCost: 1 })
        .expect(201);

      const count = await request(app.getHttpServer())
        .post('/api/v1/inventory/stock-counts')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantIds: [variantId] })
        .expect(201);
      const countId = count.body.data.id;

      // Cannot approve a DRAFT count directly.
      const earlyApprove = await request(app.getHttpServer())
        .post(`/api/v1/inventory/stock-counts/${countId}/approve`)
        .set('Authorization', auth())
        .expect(409);
      expect(earlyApprove.body.error.code).toBe('CONFLICT');

      // Cannot submit with nothing counted.
      const emptySubmit = await request(app.getHttpServer())
        .post(`/api/v1/inventory/stock-counts/${countId}/submit`)
        .set('Authorization', auth())
        .expect(422);
      expect(emptySubmit.body.error.code).toBe('VALIDATION_FAILED');

      await request(app.getHttpServer())
        .patch(`/api/v1/inventory/stock-counts/${countId}/items`)
        .set('Authorization', auth())
        .send({ items: [{ variantId, actualQuantity: 10 }] })
        .expect(200);
      await request(app.getHttpServer()).post(`/api/v1/inventory/stock-counts/${countId}/submit`).set('Authorization', auth()).expect(200);

      // Cannot edit items after submission.
      const lateEdit = await request(app.getHttpServer())
        .patch(`/api/v1/inventory/stock-counts/${countId}/items`)
        .set('Authorization', auth())
        .send({ items: [{ variantId, actualQuantity: 5 }] })
        .expect(409);
      expect(lateEdit.body.error.code).toBe('CONFLICT');

      // Cannot submit twice.
      const doubleSubmit = await request(app.getHttpServer())
        .post(`/api/v1/inventory/stock-counts/${countId}/submit`)
        .set('Authorization', auth())
        .expect(409);
      expect(doubleSubmit.body.error.code).toBe('CONFLICT');
    });
  });
});
