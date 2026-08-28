import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupPurchasingFixture, createApprovedPurchase, PurchasingFixture } from './utils/purchasing-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

describe('Purchasing: receiving (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: PurchasingFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupPurchasingFixture(app, 'receiving');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function getItemId(purchaseId: string, variantId: string): Promise<string> {
    const purchase = await request(app.getHttpServer()).get(`/api/v1/purchasing/purchases/${purchaseId}`).set('Authorization', auth()).expect(200);
    return purchase.body.data.items.find((i: { variantId: string }) => i.variantId === variantId).id;
  }

  it('full receiving in one call: increases inventory via the Inventory Engine, applies WAC, posts supplier ledger, and marks the purchase RECEIVED', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RCV-FULL-1');
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 20, unitCost: 8 }]);
    const purchaseItemId = await getItemId(purchaseId, variantId);

    const received = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId, quantityReceived: 20 }] })
      .expect(201);
    expect(received.body.data.items).toHaveLength(1);

    const purchase = await request(app.getHttpServer()).get(`/api/v1/purchasing/purchases/${purchaseId}`).set('Authorization', auth()).expect(200);
    expect(purchase.body.data.status).toBe('RECEIVED');
    expect(purchase.body.data.items[0].quantityReceived).toBe('20');

    // Real StockMovement via the Inventory Engine, never a direct write.
    const movement = await admin.stockMovement.findFirstOrThrow({
      where: { businessId: biz.businessId, variantId, movementType: 'PURCHASE', referenceType: 'PurchaseReceipt' },
    });
    expect(Number(movement.quantityBase)).toBe(20);
    expect(Number(movement.unitCostAtMovement)).toBe(8);

    const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balance.quantityOnHand)).toBe(20);
    expect(Number(balance.averageCost)).toBe(8);

    const ledger = await admin.supplierTransaction.findFirstOrThrow({
      where: { businessId: biz.businessId, supplierId: biz.supplierId, type: 'PURCHASE', referenceType: 'PurchaseReceipt' },
    });
    expect(Number(ledger.amount)).toBe(160); // 20 * 8

    const supplierGet = await request(app.getHttpServer()).get(`/api/v1/purchasing/suppliers/${biz.supplierId}`).set('Authorization', auth()).expect(200);
    expect(Number(supplierGet.body.data.balance)).toBeGreaterThanOrEqual(160);
  });

  it('partial receiving leaves the purchase PARTIALLY_RECEIVED, and a second receive for the remainder completes it (multiple receiving)', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RCV-PARTIAL-1');
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 10, unitCost: 5 }]);
    const purchaseItemId = await getItemId(purchaseId, variantId);

    await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId, quantityReceived: 6 }] })
      .expect(201);

    let purchase = await request(app.getHttpServer()).get(`/api/v1/purchasing/purchases/${purchaseId}`).set('Authorization', auth()).expect(200);
    expect(purchase.body.data.status).toBe('PARTIALLY_RECEIVED');
    expect(purchase.body.data.items[0].quantityReceived).toBe('6');

    await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId, quantityReceived: 4 }] })
      .expect(201);

    purchase = await request(app.getHttpServer()).get(`/api/v1/purchasing/purchases/${purchaseId}`).set('Authorization', auth()).expect(200);
    expect(purchase.body.data.status).toBe('RECEIVED');
    expect(purchase.body.data.items[0].quantityReceived).toBe('10');

    const movementCount = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId, movementType: 'PURCHASE' } });
    expect(movementCount).toBe(2);
    const receiptCount = await admin.purchaseReceipt.count({ where: { businessId: biz.businessId, purchaseId } });
    expect(receiptCount).toBe(2);

    const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balance.quantityOnHand)).toBe(10);
  });

  it('prevents over-receiving beyond quantityOrdered, on a single call and cumulatively across multiple calls', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RCV-OVER-1');
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 5, unitCost: 1 }]);
    const purchaseItemId = await getItemId(purchaseId, variantId);

    const overInOneShot = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId, quantityReceived: 6 }] })
      .expect(409);
    expect(overInOneShot.body.error.code).toBe('CONFLICT');

    await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId, quantityReceived: 5 }] })
      .expect(201);

    const overCumulative = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId, quantityReceived: 1 }] })
      .expect(409);
    expect(overCumulative.body.error.code).toBe('CONFLICT');

    // No stray movement/balance change from the rejected attempts.
    const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balance.quantityOnHand)).toBe(5);
  });

  it('ATOMICITY: a receive call with one valid item and one over-receiving item rolls back BOTH - no partial application', async () => {
    const { variantId: okVariant } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RCV-ATOMIC-OK');
    const { variantId: badVariant } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RCV-ATOMIC-BAD');
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [
      { variantId: okVariant, quantityOrdered: 10, unitCost: 2 },
      { variantId: badVariant, quantityOrdered: 3, unitCost: 2 },
    ]);
    const okItemId = await getItemId(purchaseId, okVariant);
    const badItemId = await getItemId(purchaseId, badVariant);

    const ledgerCountBefore = await admin.supplierTransaction.count({ where: { businessId: biz.businessId, supplierId: biz.supplierId } });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({
        items: [
          { purchaseItemId: okItemId, quantityReceived: 10 },
          { purchaseItemId: badItemId, quantityReceived: 999 }, // way over
        ],
      })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');

    // The valid line must be COMPLETELY untouched - proves the whole
    // receive is one transaction, same as the Phase 3 bundle atomicity test.
    const okBalance = await admin.stockBalance.findFirst({ where: { businessId: biz.businessId, variantId: okVariant } });
    expect(okBalance).toBeNull();
    const okMovements = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId: okVariant } });
    expect(okMovements).toBe(0);

    const purchase = await request(app.getHttpServer()).get(`/api/v1/purchasing/purchases/${purchaseId}`).set('Authorization', auth()).expect(200);
    expect(purchase.body.data.status).toBe('APPROVED'); // unchanged
    expect(purchase.body.data.items.every((i: { quantityReceived: string }) => i.quantityReceived === '0')).toBe(true);

    const receiptCount = await admin.purchaseReceipt.count({ where: { businessId: biz.businessId, purchaseId } });
    expect(receiptCount).toBe(0);
    const ledgerCountAfter = await admin.supplierTransaction.count({ where: { businessId: biz.businessId, supplierId: biz.supplierId } });
    expect(ledgerCountAfter).toBe(ledgerCountBefore); // no new supplier-ledger row from the rolled-back attempt
  });

  it('duplicate requests with the same idempotencyKey do not double-apply inventory', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RCV-IDEMP-1');
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 10, unitCost: 3 }]);
    const purchaseItemId = await getItemId(purchaseId, variantId);
    const idempotencyKey = 'test-idempotency-key-receiving-1';

    const first = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId, quantityReceived: 10 }], idempotencyKey })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId, quantityReceived: 10 }], idempotencyKey })
      .expect(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const movementCount = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId, movementType: 'PURCHASE' } });
    expect(movementCount).toBe(1);
    const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balance.quantityOnHand)).toBe(10);
  });

  it('rejects receiving on a DRAFT purchase, a CANCELLED purchase, and a fully RECEIVED purchase', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RCV-STATUS-1');
    const draft = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, supplierId: biz.supplierId, items: [{ variantId, quantityOrdered: 1, unitCost: 1 }] })
      .expect(201);
    const draftItemId = await getItemId(draft.body.data.id, variantId);
    const draftReceive = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${draft.body.data.id}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: draftItemId, quantityReceived: 1 }] })
      .expect(409);
    expect(draftReceive.body.error.code).toBe('CONFLICT');

    const { variantId: v2 } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RCV-STATUS-2');
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId: v2, quantityOrdered: 1, unitCost: 1 }]);
    const itemId = await getItemId(purchaseId, v2);
    await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: itemId, quantityReceived: 1 }] })
      .expect(201);
    const receivedAgain = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: itemId, quantityReceived: 1 }] })
      .expect(409);
    expect(receivedAgain.body.error.code).toBe('CONFLICT');

    const { variantId: v3 } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RCV-STATUS-3');
    const cancelPurchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId: v3, quantityOrdered: 1, unitCost: 1 }]);
    const cancelItemId = await getItemId(cancelPurchaseId, v3);
    await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${cancelPurchaseId}/cancel`).set('Authorization', auth()).send({}).expect(200);
    const cancelledReceive = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${cancelPurchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: cancelItemId, quantityReceived: 1 }] })
      .expect(409);
    expect(cancelledReceive.body.error.code).toBe('CONFLICT');
  });

  it('rejects a purchaseItemId that does not belong to the purchase, and rejects a duplicate purchaseItemId within one call', async () => {
    const { variantId: v1 } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RCV-FOREIGN-1');
    const { variantId: v2 } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RCV-FOREIGN-2');
    const purchaseA = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId: v1, quantityOrdered: 5, unitCost: 1 }]);
    const purchaseB = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId: v2, quantityOrdered: 5, unitCost: 1 }]);
    const itemFromB = await getItemId(purchaseB, v2);

    const foreign = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseA}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: itemFromB, quantityReceived: 1 }] })
      .expect(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');

    const itemA = await getItemId(purchaseA, v1);
    const dup = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseA}/receive`)
      .set('Authorization', auth())
      .send({
        items: [
          { purchaseItemId: itemA, quantityReceived: 1 },
          { purchaseItemId: itemA, quantityReceived: 1 },
        ],
      })
      .expect(422);
    expect(dup.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects invalid receiving quantities (zero/negative)', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RCV-INVALIDQTY-1');
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 5, unitCost: 1 }]);
    const itemId = await getItemId(purchaseId, variantId);

    const zero = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: itemId, quantityReceived: 0 }] })
      .expect(422);
    expect(zero.body.error.code).toBe('VALIDATION_FAILED');

    const negative = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: itemId, quantityReceived: -1 }] })
      .expect(422);
    expect(negative.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('WAC integration: receiving at a different cost than existing stock correctly weight-averages via the Inventory Engine', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RCV-WAC-1');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 10, unitCost: 10 })
      .expect(201); // 10 @ 10 = 100

    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 10, unitCost: 20 }]);
    const itemId = await getItemId(purchaseId, variantId);
    await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: itemId, quantityReceived: 10 }] })
      .expect(201); // +10 @ 20 = 200

    const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balance.quantityOnHand)).toBe(20);
    expect(Number(balance.averageCost)).toBeCloseTo(15, 4); // (100 + 200) / 20
  });
});
