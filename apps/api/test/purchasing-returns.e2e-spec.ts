import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupPurchasingFixture, createApprovedPurchase, PurchasingFixture } from './utils/purchasing-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

describe('Purchasing: purchase returns (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: PurchasingFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupPurchasingFixture(app, 'returns');
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

  async function receiveFull(purchaseId: string, purchaseItemId: string, quantity: number) {
    await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId, quantityReceived: quantity }] })
      .expect(201);
  }

  it('returns previously received goods: reverses inventory via the Inventory Engine (never editing the original StockMovement) and posts a supplier credit', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RET-BASIC-1');
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 10, unitCost: 4 }]);
    const itemId = await getItemId(purchaseId, variantId);
    await receiveFull(purchaseId, itemId, 10);

    const originalMovement = await admin.stockMovement.findFirstOrThrow({ where: { businessId: biz.businessId, variantId, movementType: 'PURCHASE' } });

    const ret = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/returns`)
      .set('Authorization', auth())
      .send({ reason: 'damaged goods', items: [{ purchaseItemId: itemId, quantity: 3 }] })
      .expect(201);
    expect(ret.body.data.returnNumber).toMatch(/^PRET-[A-F0-9]{8}$/);

    // Original movement is untouched - historical integrity preserved.
    const stillThere = await admin.stockMovement.findUniqueOrThrow({ where: { id: originalMovement.id } });
    expect(Number(stillThere.quantityBase)).toBe(10);

    const returnMovement = await admin.stockMovement.findFirstOrThrow({
      where: { businessId: biz.businessId, variantId, movementType: 'PURCHASE_RETURN', referenceType: 'PurchaseReturn' },
    });
    expect(Number(returnMovement.quantityBase)).toBe(-3);

    const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balance.quantityOnHand)).toBe(7);

    const purchase = await request(app.getHttpServer()).get(`/api/v1/purchasing/purchases/${purchaseId}`).set('Authorization', auth()).expect(200);
    expect(purchase.body.data.items[0].quantityReturned).toBe('3');

    const credit = await admin.supplierTransaction.findFirstOrThrow({
      where: { businessId: biz.businessId, supplierId: biz.supplierId, type: 'PURCHASE_RETURN', referenceType: 'PurchaseReturn' },
    });
    expect(Number(credit.amount)).toBe(-12); // -(3 * 4)
  });

  it('prevents returning more than was received, on a single call and cumulatively', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RET-OVER-1');
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 5, unitCost: 2 }]);
    const itemId = await getItemId(purchaseId, variantId);
    await receiveFull(purchaseId, itemId, 5);

    const overOnce = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: itemId, quantity: 6 }] })
      .expect(409);
    expect(overOnce.body.error.code).toBe('CONFLICT');

    await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: itemId, quantity: 5 }] })
      .expect(201);

    const overCumulative = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: itemId, quantity: 1 }] })
      .expect(409);
    expect(overCumulative.body.error.code).toBe('CONFLICT');
  });

  it('rejects returning against a purchase item that was never received (nothing available to return)', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RET-NEVER-1');
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 5, unitCost: 2 }]);
    const itemId = await getItemId(purchaseId, variantId);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: itemId, quantity: 1 }] })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('allows returning received goods even after the purchase was cancelled for its remaining unreceived quantity', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RET-CANCELLED-1');
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 10, unitCost: 2 }]);
    const itemId = await getItemId(purchaseId, variantId);
    await receiveFull(purchaseId, itemId, 4); // partial receipt

    await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${purchaseId}/cancel`).set('Authorization', auth()).send({}).expect(200);

    const ret = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: itemId, quantity: 2 }] })
      .expect(201);
    expect(ret.body.data.items).toHaveLength(1);
  });

  it('rejects invalid return quantities and a duplicate purchaseItemId within one call', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RET-INVALID-1');
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 5, unitCost: 2 }]);
    const itemId = await getItemId(purchaseId, variantId);
    await receiveFull(purchaseId, itemId, 5);

    const zero = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: itemId, quantity: 0 }] })
      .expect(422);
    expect(zero.body.error.code).toBe('VALIDATION_FAILED');

    const dup = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/returns`)
      .set('Authorization', auth())
      .send({
        items: [
          { purchaseItemId: itemId, quantity: 1 },
          { purchaseItemId: itemId, quantity: 1 },
        ],
      })
      .expect(422);
    expect(dup.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('records a purchase payment and reflects it in the supplier balance, without inventing any accounting entities', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PAY-1');
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 5, unitCost: 10 }]);
    const itemId = await getItemId(purchaseId, variantId);
    await receiveFull(purchaseId, itemId, 5); // supplier owed 50

    const balanceBefore = await request(app.getHttpServer()).get(`/api/v1/purchasing/suppliers/${biz.supplierId}`).set('Authorization', auth()).expect(200);
    const before = Number(balanceBefore.body.data.balance);

    const payment = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/payments`)
      .set('Authorization', auth())
      .send({ amount: 20, method: 'CASH', reference: 'CASH-001' })
      .expect(201);
    expect(payment.body.data.amount).toBe('20');

    const balanceAfter = await request(app.getHttpServer()).get(`/api/v1/purchasing/suppliers/${biz.supplierId}`).set('Authorization', auth()).expect(200);
    expect(Number(balanceAfter.body.data.balance)).toBe(before - 20);

    const invalidAmount = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/payments`)
      .set('Authorization', auth())
      .send({ amount: 0 })
      .expect(422);
    expect(invalidAmount.body.error.code).toBe('VALIDATION_FAILED');
  });
});
