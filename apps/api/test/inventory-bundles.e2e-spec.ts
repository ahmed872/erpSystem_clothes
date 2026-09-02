import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupInventoryFixture, createSimpleProduct, InventoryFixture } from './utils/inventory-fixtures';

describe('Inventory: bundle consumption (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: InventoryFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupInventoryFixture(app, 'bundles');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function createBundle(componentVariantId: string, componentQty: number, sku: string) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', auth())
      .send({
        sku,
        name: sku,
        type: 'BUNDLE',
        baseUomId: biz.uomId,
        defaultSellingPrice: 50,
        bundleItems: [{ variantId: componentVariantId, quantity: componentQty }],
      })
      .expect(201);
    return { bundleProductId: res.body.data.id as string, bundleVariantId: res.body.data.variants[0].id as string };
  }

  it('selling a bundle consumes its component(s), never the bundle variant itself', async () => {
    const { variantId: chargerVariantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'BNDL-CHARGER', {
      defaultCost: 5,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId: chargerVariantId, quantity: 100, unitCost: 5 })
      .expect(201);

    const { bundleVariantId } = await createBundle(chargerVariantId, 1, 'BNDL-1');

    const sale = await request(app.getHttpServer())
      .post('/api/v1/inventory/consumptions')
      .set('Authorization', auth())
      .send({ referenceType: 'Sale', referenceId: 'fixture-sale', warehouseId: biz.warehouseId, variantId: bundleVariantId, quantity: 3 })
      .expect(201);
    expect(sale.body.data.componentsConsumed).toHaveLength(1);
    expect(sale.body.data.componentsConsumed[0]).toMatchObject({ variantId: chargerVariantId, quantityConsumed: '3' });

    // The bundle's OWN balance must never exist - it carries no inventory.
    const bundleBalance = await admin.stockBalance.findFirst({ where: { businessId: biz.businessId, variantId: bundleVariantId } });
    expect(bundleBalance).toBeNull();

    const componentBalance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: chargerVariantId } });
    expect(Number(componentBalance.quantityOnHand)).toBe(97); // 100 - 3

    const componentMovements = await admin.stockMovement.findMany({ where: { businessId: biz.businessId, variantId: chargerVariantId, movementType: 'BUNDLE_CONSUMPTION' } });
    expect(componentMovements).toHaveLength(1);
    expect(Number(componentMovements[0].quantityBase)).toBe(-3);
  });

  it('consuming a multi-component bundle decrements EVERY component by quantity × its own bundle ratio, atomically', async () => {
    const { variantId: phoneVariantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'BNDL-PHONE', { defaultCost: 100 });
    const { variantId: caseVariantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'BNDL-CASE', { defaultCost: 3 });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId: phoneVariantId, quantity: 50, unitCost: 100 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId: caseVariantId, quantity: 200, unitCost: 3 })
      .expect(201);

    const bundle = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', auth())
      .send({
        sku: 'BNDL-MULTI',
        name: 'Phone + 2 Cases',
        type: 'BUNDLE',
        baseUomId: biz.uomId,
        bundleItems: [
          { variantId: phoneVariantId, quantity: 1 },
          { variantId: caseVariantId, quantity: 2 },
        ],
      })
      .expect(201);
    const bundleVariantId = bundle.body.data.variants[0].id;

    await request(app.getHttpServer())
      .post('/api/v1/inventory/consumptions')
      .set('Authorization', auth())
      .send({ referenceType: 'Sale', referenceId: 'fixture-sale', warehouseId: biz.warehouseId, variantId: bundleVariantId, quantity: 4 })
      .expect(201);

    const phoneBalance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: phoneVariantId } });
    expect(Number(phoneBalance.quantityOnHand)).toBe(46); // 50 - 4*1
    const caseBalance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: caseVariantId } });
    expect(Number(caseBalance.quantityOnHand)).toBe(192); // 200 - 4*2
  });

  it('ATOMICITY: if one component is short, the ENTIRE bundle sale rolls back - no partial consumption', async () => {
    const { variantId: plentifulVariantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'BNDL-PLENTY', { defaultCost: 2 });
    const { variantId: scarceVariantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'BNDL-SCARCE', { defaultCost: 50 });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId: plentifulVariantId, quantity: 1000, unitCost: 2 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId: scarceVariantId, quantity: 2, unitCost: 50 })
      .expect(201); // only 2 in stock

    const bundle = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', auth())
      .send({
        sku: 'BNDL-ATOMIC',
        name: 'Atomic Bundle',
        type: 'BUNDLE',
        baseUomId: biz.uomId,
        bundleItems: [
          { variantId: plentifulVariantId, quantity: 1 },
          { variantId: scarceVariantId, quantity: 1 },
        ],
      })
      .expect(201);
    const bundleVariantId = bundle.body.data.variants[0].id;

    // Selling 5 bundles needs 5 of the scarce component - only 2 exist.
    const res = await request(app.getHttpServer())
      .post('/api/v1/inventory/consumptions')
      .set('Authorization', auth())
      .send({ referenceType: 'Sale', referenceId: 'fixture-sale', warehouseId: biz.warehouseId, variantId: bundleVariantId, quantity: 5 })
      .expect(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');

    // The plentiful component must be COMPLETELY untouched - not
    // partially consumed before the scarce one failed. This is what
    // proves the whole bundle sale is one DB transaction.
    const plentifulBalance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: plentifulVariantId } });
    expect(Number(plentifulBalance.quantityOnHand)).toBe(1000);
    const scarceBalance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: scarceVariantId } });
    expect(Number(scarceBalance.quantityOnHand)).toBe(2);

    const plentifulMovements = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId: plentifulVariantId, movementType: 'BUNDLE_CONSUMPTION' } });
    expect(plentifulMovements).toBe(0);
  });
});
