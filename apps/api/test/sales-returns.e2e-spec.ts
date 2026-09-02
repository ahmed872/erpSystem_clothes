import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

describe('Sales: sale returns (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'returns');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function stockUp(variantId: string, quantity: number, unitCost: number) {
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity, unitCost })
      .expect(201);
  }

  async function createSale(customerId: string | undefined, variantId: string, quantity: number, unitPrice: number) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        customerId,
        items: [{ variantId, quantity, unitPrice }],
        payments: customerId ? [] : [{ amount: quantity * unitPrice }],
      })
      .expect(201);
    return { saleId: res.body.data.id as string, saleItemId: res.body.data.items[0].id as string };
  }

  it('returns a SELLABLE item: reverses inventory at the ORIGINAL sale cost (not today\'s average), never touching the original SALE movement, and credits the customer', async () => {
    const customer = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: 'Return Customer 1' }).expect(201);
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RET-SELLABLE-1');
    await stockUp(variantId, 20, 4); // avg cost 4 at time of sale
    const { saleId, saleItemId } = await createSale(customer.body.data.id, variantId, 5, 10);

    // Change the average cost AFTER the sale by receiving more stock at a very different cost.
    await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ referenceType: 'PurchaseReceipt', referenceId: 'fixture-receipt', warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 100 })
      .expect(201); // avg cost now drifts way up

    const originalMovement = await admin.stockMovement.findFirstOrThrow({
      where: { businessId: biz.businessId, variantId, movementType: 'SALE', referenceType: 'Sale', referenceId: saleId },
    });
    expect(Number(originalMovement.unitCostAtMovement)).toBe(4);

    const ret = await request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/returns`)
      .set('Authorization', auth())
      .send({ reason: 'wrong size', items: [{ saleItemId, quantity: 2, condition: 'SELLABLE' }] })
      .expect(201);
    expect(ret.body.data.returnNumber).toMatch(/^SRET-[A-F0-9]{8}$/);

    // The original movement is untouched.
    const stillThere = await admin.stockMovement.findUniqueOrThrow({ where: { id: originalMovement.id } });
    expect(Number(stillThere.quantityBase)).toBe(-5);
    expect(Number(stillThere.unitCostAtMovement)).toBe(4);

    const returnMovement = await admin.stockMovement.findFirstOrThrow({
      where: { businessId: biz.businessId, variantId, movementType: 'SALES_RETURN', referenceType: 'SaleReturn', referenceId: ret.body.data.id },
    });
    expect(Number(returnMovement.quantityBase)).toBe(2);
    // Costed at the ORIGINAL sale cost (4), carried over - never the drifted current average.
    expect(Number(returnMovement.unitCostAtMovement)).toBe(4);

    const saleItem = await admin.saleItem.findUniqueOrThrow({ where: { id: saleItemId } });
    expect(Number(saleItem.quantityReturned)).toBe(2);

    const credit = await admin.customerTransaction.findFirstOrThrow({
      where: { businessId: biz.businessId, customerId: customer.body.data.id, type: 'SALE_RETURN', referenceType: 'SaleReturn', referenceId: ret.body.data.id },
    });
    expect(Number(credit.amount)).toBe(-20); // -(2 * 10 unitPrice)
  });

  it('returns a DAMAGED item: posts a SALES_RETURN increase immediately followed by a DAMAGE decrease (net zero stock effect, both events visible), still credits the customer', async () => {
    const customer = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: 'Return Customer 2' }).expect(201);
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RET-DAMAGED-1');
    await stockUp(variantId, 20, 5);
    const { saleId, saleItemId } = await createSale(customer.body.data.id, variantId, 3, 12);

    const balanceBefore = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });

    const ret = await request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity: 1, condition: 'DAMAGED' }] })
      .expect(201);

    const balanceAfter = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balanceAfter.quantityOnHand)).toBe(Number(balanceBefore.quantityOnHand)); // net zero

    const salesReturnMovement = await admin.stockMovement.findFirstOrThrow({
      where: { businessId: biz.businessId, variantId, movementType: 'SALES_RETURN', referenceType: 'SaleReturn', referenceId: ret.body.data.id },
    });
    expect(Number(salesReturnMovement.quantityBase)).toBe(1);
    const damageMovement = await admin.stockMovement.findFirstOrThrow({
      where: { businessId: biz.businessId, variantId, movementType: 'DAMAGE', referenceType: 'SaleReturn', referenceId: ret.body.data.id },
    });
    expect(Number(damageMovement.quantityBase)).toBe(-1);

    // Customer is still credited - a damaged return is the store's loss, not the customer's.
    const credit = await admin.customerTransaction.findFirstOrThrow({
      where: { businessId: biz.businessId, customerId: customer.body.data.id, type: 'SALE_RETURN', referenceId: ret.body.data.id },
    });
    expect(Number(credit.amount)).toBe(-12);
  });

  it('prevents over-returning beyond quantity sold, on a single call and cumulatively', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RET-OVER-1');
    await stockUp(variantId, 20, 5);
    const { saleId, saleItemId } = await createSale(undefined, variantId, 5, 10);

    const overOnce = await request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity: 6 }] })
      .expect(409);
    expect(overOnce.body.error.code).toBe('CONFLICT');

    // Phase 10 (BD-23): a walk-in return must be refunded in full - there
    // is no customer account for a remainder to sit on. 5 x 10 = 50.
    await request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity: 5 }], refund: { method: 'CASH', amount: 50 } })
      .expect(201);

    const overCumulative = await request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity: 1 }] })
      .expect(409);
    expect(overCumulative.body.error.code).toBe('CONFLICT');
  });

  it('rejects returning a Bundle-type sale item', async () => {
    const { variantId: componentId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RET-BUNDLE-COMPONENT-1');
    await stockUp(componentId, 50, 3);
    const bundle = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', auth())
      .send({ sku: 'RET-BUNDLE-1', name: 'Return Bundle', type: 'BUNDLE', baseUomId: biz.uomId, bundleItems: [{ variantId: componentId, quantity: 1 }] })
      .expect(201);
    const bundleVariantId = bundle.body.data.variants[0].id;

    const { saleId, saleItemId } = await createSale(undefined, bundleVariantId, 2, 20);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity: 1 }] })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a duplicate saleItemId within one call, and a saleItemId foreign to the sale', async () => {
    const { variantId: v1 } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RET-DUP-1');
    const { variantId: v2 } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RET-DUP-2');
    await stockUp(v1, 10, 5);
    await stockUp(v2, 10, 5);
    const saleA = await createSale(undefined, v1, 5, 10);
    const saleB = await createSale(undefined, v2, 5, 10);

    const dup = await request(app.getHttpServer())
      .post(`/api/v1/sales/${saleA.saleId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId: saleA.saleItemId, quantity: 1 }, { saleItemId: saleA.saleItemId, quantity: 1 }] })
      .expect(422);
    expect(dup.body.error.code).toBe('VALIDATION_FAILED');

    const foreign = await request(app.getHttpServer())
      .post(`/api/v1/sales/${saleA.saleId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId: saleB.saleItemId, quantity: 1 }] })
      .expect(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');
  });

  it('sequential idempotency: a retried return request after the first commits returns the original return, not a duplicate', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RET-IDEMP-1');
    await stockUp(variantId, 10, 5);
    const { saleId, saleItemId } = await createSale(undefined, variantId, 5, 10);
    const idempotencyKey = 'test-idempotency-sale-return-1';

    const first = await request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity: 2 }], idempotencyKey, refund: { method: 'CASH', amount: 20 } })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity: 2 }], idempotencyKey, refund: { method: 'CASH', amount: 20 } })
      .expect(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const movementCount = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId, movementType: 'SALES_RETURN' } });
    expect(movementCount).toBe(1);
  });

  it('IDEMPOTENCY KEY REUSE: the same key with a materially different quantity is rejected, not silently substituted for the original return', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RET-IDEMP-MISMATCH-1');
    await stockUp(variantId, 10, 5);
    const { saleId, saleItemId } = await createSale(undefined, variantId, 8, 10);
    const idempotencyKey = 'test-idempotency-sale-return-mismatch-1';

    const first = await request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity: 2 }], idempotencyKey, refund: { method: 'CASH', amount: 20 } })
      .expect(201);

    const mismatch = await request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity: 3 }], idempotencyKey, refund: { method: 'CASH', amount: 30 } }) // different quantity
      .expect(409);
    expect(mismatch.body.error.code).toBe('CONFLICT');

    const returnCount = await admin.saleReturn.count({ where: { businessId: biz.businessId, idempotencyKey } });
    expect(returnCount).toBe(1);
    expect(first.body.data.items[0].quantity).toBe('2'); // unchanged by the rejected mismatch
  });
});
