import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupInventoryFixture, createSimpleProduct, InventoryFixture } from './utils/inventory-fixtures';

describe('Inventory: opening stock, receive, consume, WAC (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: InventoryFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupInventoryFixture(app, 'stockbasics');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  it('records opening stock exactly once, and rejects a second attempt for the same variant/warehouse', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'OPEN-1');

    const res = await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 50, unitCost: 8 })
      .expect(201);
    expect(res.body.data.quantityOnHand).toBe('50');
    expect(res.body.data.averageCost).toBe('8');

    const dup = await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 10, unitCost: 8 })
      .expect(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('computes the correct Weighted Average Cost across opening stock + two purchases at different costs', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'WAC-1');

    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 100, unitCost: 10 })
      .expect(201);

    // 100 @ 10 = 1000. + 50 @ 16 = 800. Total 150 units, 1800 -> 12/unit.
    const r1 = await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 50, unitCost: 16 })
      .expect(201);
    expect(r1.body.data.quantityOnHand).toBe('150');
    expect(r1.body.data.averageCost).toBe('12');

    // + 50 @ 18 = 900. Total 200 units, 2700 -> 13.5/unit.
    const r2 = await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 50, unitCost: 18 })
      .expect(201);
    expect(r2.body.data.quantityOnHand).toBe('200');
    expect(r2.body.data.averageCost).toBe('13.5');
  });

  it('a sale locks in the CURRENT average cost as COGS, and does not itself change the average cost', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'COGS-1');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 100, unitCost: 10 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 50, unitCost: 16 })
      .expect(201); // avg now 12

    const sale = await request(app.getHttpServer())
      .post('/api/v1/inventory/consumptions')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 30 })
      .expect(201);
    expect(sale.body.data.quantityOnHand).toBe('120');
    expect(sale.body.data.cogsPerUnit).toBe('12');
    expect(sale.body.data.averageCost).toBe('12'); // unchanged by the sale
  });

  it('a later cost change never rewrites a past movement\'s recorded unit_cost_at_movement (historical COGS integrity)', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'HIST-1');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 100, unitCost: 10 })
      .expect(201);

    const sale = await request(app.getHttpServer())
      .post('/api/v1/inventory/consumptions')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 10 })
      .expect(201);
    expect(sale.body.data.cogsPerUnit).toBe('10');

    // A much higher-cost purchase changes the AVERAGE going forward...
    await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 10, unitCost: 1000 })
      .expect(201);

    // ...but the historical sale movement's own unit_cost_at_movement in
    // the database is untouched.
    const movement = await admin.stockMovement.findUniqueOrThrow({ where: { id: sale.body.data.movementId } });
    expect(Number(movement.unitCostAtMovement)).toBe(10);
  });

  it('rejects a consumption/adjustment with an invalid warehouse or variant reference (404, not silently ignored)', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'BADREF-1');

    const badWarehouse = await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: '00000000-0000-0000-0000-000000000000', variantId, quantity: 1, unitCost: 1 })
      .expect(404);
    expect(badWarehouse.body.error.code).toBe('NOT_FOUND');

    const badVariant = await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId: '00000000-0000-0000-0000-000000000000', quantity: 1, unitCost: 1 })
      .expect(404);
    expect(badVariant.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects non-positive quantities and a zero adjustment at the validation layer (422, before touching the DB)', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'BADQTY-1');

    const zeroReceive = await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 0, unitCost: 1 })
      .expect(422);
    expect(zeroReceive.body.error.code).toBe('VALIDATION_FAILED');

    const negativeReceive = await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: -5, unitCost: 1 })
      .expect(422);
    expect(negativeReceive.body.error.code).toBe('VALIDATION_FAILED');

    const zeroAdjust = await request(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 0, movementType: 'ADJUSTMENT', reason: 'test' })
      .expect(422);
    expect(zeroAdjust.body.error.code).toBe('VALIDATION_FAILED');

    const noReason = await request(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 5, movementType: 'ADJUSTMENT' })
      .expect(422);
    expect(noReason.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('multi-UOM: receiving in Cartons converts correctly to base Pieces using the configured conversion factor', async () => {
    const { productId, variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'MULTIUOM-STOCK');
    await request(app.getHttpServer())
      .post(`/api/v1/catalog/products/${productId}/uoms`)
      .set('Authorization', auth())
      .send({ uomId: biz.cartonUomId, conversionFactor: 12, isPurchaseUom: true })
      .expect(201);

    // Buy 5 Cartons @ $120/Carton = 60 Pieces @ $10/Piece.
    const res = await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 5, unitCost: 120, uomId: biz.cartonUomId })
      .expect(201);
    expect(res.body.data.quantityOnHand).toBe('60');
    expect(res.body.data.averageCost).toBe('10');
  });

  describe('Negative inventory (disabled by default)', () => {
    it('rejects a sale that would go negative by default, even for the Business Owner', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'NEGDEFAULT-1');
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 5, unitCost: 10 })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/inventory/consumptions')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 10 })
        .expect(409);
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');

      const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
      expect(Number(balance.quantityOnHand)).toBe(5); // untouched by the rejected attempt
    });

    it('still rejects when the tenant Setting is enabled but the actor lacks inventory.allow_negative', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'NEGNOPERM-1');
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 5, unitCost: 10 })
        .expect(201);

      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'inventory.allow_negative_stock', value: true })
        .expect(200);

      // Owner role DOES have inventory.allow_negative (owner gets every
      // permission) - use a role WITHOUT it to prove the setting alone
      // is not sufficient.
      const invRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'INVENTORY_MANAGER' } });
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'Inv Mgr', email: `invmgr-neg@${biz.slug}.test`, password: 'InvMgrPass1!', roleIds: [invRole.id] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `invmgr-neg@${biz.slug}.test`, password: 'InvMgrPass1!', businessSlug: biz.slug })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/api/v1/inventory/consumptions')
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 10 })
        .expect(409);
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    });

    it('allows going negative only when BOTH the setting is on AND the actor has inventory.allow_negative, and flags the movement', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'NEGALLOWED-1');
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 5, unitCost: 10 })
        .expect(201);

      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'inventory.allow_negative_stock', value: true })
        .expect(200);

      // Owner has inventory.allow_negative by default (owns every permission).
      const res = await request(app.getHttpServer())
        .post('/api/v1/inventory/consumptions')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 8 })
        .expect(201);
      expect(res.body.data.quantityOnHand).toBe('-3');

      const movement = await admin.stockMovement.findUniqueOrThrow({ where: { id: res.body.data.movementId } });
      expect(movement.isNegativeStock).toBe(true);
    });
  });

  it('reconciliation reports zero discrepancies after a normal sequence of movements, and DOES detect a manually corrupted balance', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RECON-1');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 40, unitCost: 5 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/inventory/consumptions')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 15 })
      .expect(201);

    const clean = await request(app.getHttpServer())
      .get(`/api/v1/inventory/reconciliation?warehouseId=${biz.warehouseId}`)
      .set('Authorization', auth())
      .expect(200);
    expect(clean.body.data.discrepancies).toEqual([]);

    // Directly corrupt the cache via the admin (superuser) connection,
    // bypassing the engine entirely - simulates a hypothetical bug.
    await admin.$executeRawUnsafe(
      `UPDATE stock_balances SET quantity_on_hand = 999 WHERE business_id = $1 AND variant_id = $2`,
      biz.businessId,
      variantId,
    );

    const dirty = await request(app.getHttpServer())
      .get(`/api/v1/inventory/reconciliation?warehouseId=${biz.warehouseId}`)
      .set('Authorization', auth())
      .expect(200);
    expect(dirty.body.data.discrepancies).toHaveLength(1);
    expect(dirty.body.data.discrepancies[0]).toMatchObject({ variantId, cachedQuantityOnHand: '999', computedFromLedger: '25' });
  });
});
