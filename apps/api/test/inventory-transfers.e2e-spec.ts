import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupInventoryFixture, createSimpleProduct, InventoryFixture } from './utils/inventory-fixtures';

describe('Inventory: stock transfers (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: InventoryFixture;
  let secondWarehouseId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupInventoryFixture(app, 'transfers');

    const wh = await request(app.getHttpServer())
      .post('/api/v1/warehouses')
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .send({ branchId: biz.branchId, name: 'Second Warehouse' })
      .expect(201);
    secondWarehouseId = wh.body.data.id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  it('full lifecycle: create -> send (decrements source only) -> receive (increments destination, carrying over source cost)', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'XFER-1');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 100, unitCost: 20 })
      .expect(201);

    const transfer = await request(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', auth())
      .send({ sourceWarehouseId: biz.warehouseId, destinationWarehouseId: secondWarehouseId, items: [{ variantId, quantity: 30 }] })
      .expect(201);
    const transferId = transfer.body.data.id;
    expect(transfer.body.data.status).toBe('DRAFT');

    // Draft creates NO movement and reserves nothing.
    const sourceBeforeSend = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, warehouseId: biz.warehouseId, variantId } });
    expect(Number(sourceBeforeSend.quantityOnHand)).toBe(100);

    const sent = await request(app.getHttpServer()).post(`/api/v1/inventory/transfers/${transferId}/send`).set('Authorization', auth()).expect(200);
    expect(sent.body.data.status).toBe('IN_TRANSIT');

    const sourceAfterSend = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, warehouseId: biz.warehouseId, variantId } });
    expect(Number(sourceAfterSend.quantityOnHand)).toBe(70); // decremented

    const destAfterSend = await admin.stockBalance.findFirst({ where: { businessId: biz.businessId, warehouseId: secondWarehouseId, variantId } });
    expect(destAfterSend).toBeNull(); // destination untouched until receive

    const received = await request(app.getHttpServer())
      .post(`/api/v1/inventory/transfers/${transferId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ variantId, quantityReceived: 30 }] })
      .expect(200);
    expect(received.body.data.status).toBe('COMPLETED');

    const destAfterReceive = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, warehouseId: secondWarehouseId, variantId } });
    expect(Number(destAfterReceive.quantityOnHand)).toBe(30);
    // Cost basis carried over from the SOURCE's cost at send time (20),
    // never fabricated as a new "purchase" cost.
    expect(Number(destAfterReceive.averageCost)).toBe(20);
  });

  it('records a shrinkage difference when quantityReceived is less than quantity sent, without silently correcting it', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'XFER-SHRINK-1');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 50, unitCost: 10 })
      .expect(201);

    const transfer = await request(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', auth())
      .send({ sourceWarehouseId: biz.warehouseId, destinationWarehouseId: secondWarehouseId, items: [{ variantId, quantity: 20 }] })
      .expect(201);
    const transferId = transfer.body.data.id;
    await request(app.getHttpServer()).post(`/api/v1/inventory/transfers/${transferId}/send`).set('Authorization', auth()).expect(200);

    // Only 18 arrived (2 damaged/lost in transit).
    const received = await request(app.getHttpServer())
      .post(`/api/v1/inventory/transfers/${transferId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ variantId, quantityReceived: 18 }] })
      .expect(200);
    expect(received.body.data.items[0].quantityReceived).toBe('18');
    expect(received.body.data.items[0].quantity).toBe('20');

    const dest = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, warehouseId: secondWarehouseId, variantId } });
    expect(Number(dest.quantityOnHand)).toBe(18); // only what actually arrived
  });

  it('rejects sending a transfer twice, and rejects receiving a DRAFT transfer', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'XFER-STATUS-1');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 5 })
      .expect(201);

    const transfer = await request(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', auth())
      .send({ sourceWarehouseId: biz.warehouseId, destinationWarehouseId: secondWarehouseId, items: [{ variantId, quantity: 5 }] })
      .expect(201);
    const transferId = transfer.body.data.id;

    const earlyReceive = await request(app.getHttpServer())
      .post(`/api/v1/inventory/transfers/${transferId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ variantId, quantityReceived: 5 }] })
      .expect(409);
    expect(earlyReceive.body.error.code).toBe('CONFLICT');

    await request(app.getHttpServer()).post(`/api/v1/inventory/transfers/${transferId}/send`).set('Authorization', auth()).expect(200);
    const doubleSend = await request(app.getHttpServer()).post(`/api/v1/inventory/transfers/${transferId}/send`).set('Authorization', auth()).expect(409);
    expect(doubleSend.body.error.code).toBe('CONFLICT');
  });

  it('rejects a transfer with the same source and destination warehouse, and rejects sending when source stock is insufficient', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'XFER-VALID-1');

    const sameWarehouse = await request(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', auth())
      .send({ sourceWarehouseId: biz.warehouseId, destinationWarehouseId: biz.warehouseId, items: [{ variantId, quantity: 1 }] })
      .expect(422);
    expect(sameWarehouse.body.error.code).toBe('VALIDATION_FAILED');

    // No opening stock recorded - source has 0.
    const transfer = await request(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', auth())
      .send({ sourceWarehouseId: biz.warehouseId, destinationWarehouseId: secondWarehouseId, items: [{ variantId, quantity: 5 }] })
      .expect(201);

    const send = await request(app.getHttpServer())
      .post(`/api/v1/inventory/transfers/${transfer.body.data.id}/send`)
      .set('Authorization', auth())
      .expect(409);
    expect(send.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('requires all transfer items to be received together, matching exactly what was sent', async () => {
    const { variantId: v1 } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'XFER-PARTIAL-1');
    const { variantId: v2 } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'XFER-PARTIAL-2');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId: v1, quantity: 10, unitCost: 1 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId: v2, quantity: 10, unitCost: 1 })
      .expect(201);

    const transfer = await request(app.getHttpServer())
      .post('/api/v1/inventory/transfers')
      .set('Authorization', auth())
      .send({
        sourceWarehouseId: biz.warehouseId,
        destinationWarehouseId: secondWarehouseId,
        items: [{ variantId: v1, quantity: 5 }, { variantId: v2, quantity: 5 }],
      })
      .expect(201);
    const transferId = transfer.body.data.id;
    await request(app.getHttpServer()).post(`/api/v1/inventory/transfers/${transferId}/send`).set('Authorization', auth()).expect(200);

    const partial = await request(app.getHttpServer())
      .post(`/api/v1/inventory/transfers/${transferId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ variantId: v1, quantityReceived: 5 }] }) // missing v2
      .expect(422);
    expect(partial.body.error.code).toBe('VALIDATION_FAILED');
  });
});
