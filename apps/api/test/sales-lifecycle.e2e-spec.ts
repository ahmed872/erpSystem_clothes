import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

describe('Sales: sale lifecycle and payment integrity (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'lifecycle');
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

  it('completes a fully-paid walk-in sale: correct totals, SALE inventory movement, no customer ledger effect', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SALE-BASIC-1');
    await stockUp(variantId, 20, 5);

    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        items: [{ variantId, quantity: 3, unitPrice: 15, discountAmount: 3, taxAmount: 2 }],
        payments: [{ amount: 44, method: 'CASH' }],
      })
      .expect(201);
    expect(res.body.data.saleNumber).toMatch(/^INV-[A-F0-9]{8}$/);
    expect(res.body.data.subtotal).toBe('45'); // 3*15
    expect(res.body.data.discountAmount).toBe('3');
    expect(res.body.data.taxAmount).toBe('2');
    expect(res.body.data.totalAmount).toBe('44'); // 45-3+2
    expect(res.body.data.branchId).toBe(biz.branchId);
    expect(res.body.data.shiftId).toBe(biz.activeShiftId);

    const movement = await admin.stockMovement.findFirstOrThrow({
      where: { businessId: biz.businessId, variantId, movementType: 'SALE', referenceType: 'Sale', referenceId: res.body.data.id },
    });
    expect(Number(movement.quantityBase)).toBe(-3);

    const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balance.quantityOnHand)).toBe(17);

    const ledgerCount = await admin.customerTransaction.count({ where: { businessId: biz.businessId, referenceId: res.body.data.id } });
    expect(ledgerCount).toBe(0); // no customer on this sale
  });

  it('completes a credit sale against a customer: posts SALE (+total) and PAYMENT (-paid) ledger entries, computes remaining correctly', async () => {
    const customer = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: 'Credit Customer 1' }).expect(201);
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SALE-CREDIT-1');
    await stockUp(variantId, 20, 4);

    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        customerId: customer.body.data.id,
        items: [{ variantId, quantity: 2, unitPrice: 20 }],
        payments: [{ amount: 15, method: 'CASH' }],
      })
      .expect(201);
    expect(res.body.data.totalAmount).toBe('40');

    const saleTxn = await admin.customerTransaction.findFirstOrThrow({
      where: { businessId: biz.businessId, customerId: customer.body.data.id, type: 'SALE', referenceId: res.body.data.id },
    });
    expect(Number(saleTxn.amount)).toBe(40);
    const paymentTxn = await admin.customerTransaction.findFirstOrThrow({
      where: { businessId: biz.businessId, customerId: customer.body.data.id, type: 'PAYMENT', referenceId: res.body.data.id },
    });
    expect(Number(paymentTxn.amount)).toBe(-15);

    const customerGet = await request(app.getHttpServer()).get(`/api/v1/sales/customers/${customer.body.data.id}`).set('Authorization', auth()).expect(200);
    expect(Number(customerGet.body.data.balance)).toBe(25); // 40 owed - 15 paid
  });

  it('allows a fully-credit sale (zero payment) against a customer, and later payments pay it down without overpaying', async () => {
    const customer = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: 'Credit Customer 2' }).expect(201);
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SALE-FULLCREDIT-1');
    await stockUp(variantId, 20, 4);

    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, customerId: customer.body.data.id, items: [{ variantId, quantity: 1, unitPrice: 30 }], payments: [] })
      .expect(201);
    const saleId = res.body.data.id;

    const paid1 = await request(app.getHttpServer()).post(`/api/v1/sales/${saleId}/payments`).set('Authorization', auth()).send({ amount: 20 }).expect(201);
    expect(paid1.body.data.amount).toBe('20');

    const overpay = await request(app.getHttpServer()).post(`/api/v1/sales/${saleId}/payments`).set('Authorization', auth()).send({ amount: 20 }).expect(409);
    expect(overpay.body.error.code).toBe('CONFLICT');

    await request(app.getHttpServer()).post(`/api/v1/sales/${saleId}/payments`).set('Authorization', auth()).send({ amount: 10 }).expect(201);

    const fullyPaidAgain = await request(app.getHttpServer()).post(`/api/v1/sales/${saleId}/payments`).set('Authorization', auth()).send({ amount: 1 }).expect(409);
    expect(fullyPaidAgain.body.error.code).toBe('CONFLICT');
  });

  it('rejects a walk-in sale (no customer) that is not paid in full', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SALE-WALKIN-PARTIAL-1');
    await stockUp(variantId, 10, 5);

    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 20 }], payments: [{ amount: 10 }] })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects payments exceeding the sale total (no overpayment/change tracking)', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SALE-OVERPAY-1');
    await stockUp(variantId, 10, 5);

    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 20 }], payments: [{ amount: 50 }] })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects empty items, unknown variant, duplicate variant, zero/negative quantity, and an unknown warehouse', async () => {
    const noItems = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [], payments: [] })
      .expect(422);
    expect(noItems.body.error.code).toBe('VALIDATION_FAILED');

    const unknownVariant = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId: '00000000-0000-0000-0000-000000000000', quantity: 1, unitPrice: 1 }], payments: [{ amount: 1 }] })
      .expect(404);
    expect(unknownVariant.body.error.code).toBe('NOT_FOUND');

    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SALE-DUP-1');
    await stockUp(variantId, 10, 5);
    const dup = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        items: [
          { variantId, quantity: 1, unitPrice: 10 },
          { variantId, quantity: 1, unitPrice: 10 },
        ],
        payments: [{ amount: 20 }],
      })
      .expect(422);
    expect(dup.body.error.code).toBe('VALIDATION_FAILED');

    const zeroQty = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 0, unitPrice: 10 }], payments: [] })
      .expect(422);
    expect(zeroQty.body.error.code).toBe('VALIDATION_FAILED');

    const badWarehouse = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: '00000000-0000-0000-0000-000000000000', items: [{ variantId, quantity: 1, unitPrice: 10 }], payments: [{ amount: 10 }] })
      .expect(404);
    expect(badWarehouse.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects selling to an inactive customer', async () => {
    const customer = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: 'Inactive Customer' }).expect(201);
    await request(app.getHttpServer()).delete(`/api/v1/sales/customers/${customer.body.data.id}`).set('Authorization', auth()).expect(200);

    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SALE-INACTIVECUST-1');
    await stockUp(variantId, 10, 5);
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, customerId: customer.body.data.id, items: [{ variantId, quantity: 1, unitPrice: 10 }], payments: [{ amount: 10 }] })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('PRICE SNAPSHOT INTEGRITY: SaleItem.unitPrice never changes even after the variant price changes later', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SALE-SNAPSHOT-1', { defaultSellingPrice: 25 });
    await stockUp(variantId, 10, 5);

    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 25 }], payments: [{ amount: 25 }] })
      .expect(201);
    const saleId = res.body.data.id;

    // Change the variant's current selling price after the sale.
    await request(app.getHttpServer())
      .patch(`/api/v1/catalog/variants/${variantId}/price`)
      .set('Authorization', auth())
      .send({ sellingPrice: 999 })
      .expect(200);

    const reread = await request(app.getHttpServer()).get(`/api/v1/sales/${saleId}`).set('Authorization', auth()).expect(200);
    expect(reread.body.data.items[0].unitPrice).toBe('25'); // unchanged
    expect(reread.body.data.totalAmount).toBe('25'); // unchanged
  });

  it('sells a Bundle-type variant, consuming its components via the same consumeVariant path used by standalone inventory consumption', async () => {
    const { variantId: componentId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SALE-BUNDLE-COMPONENT-1', { defaultCost: 4 });
    await stockUp(componentId, 50, 4);

    const bundle = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', auth())
      .send({
        sku: 'SALE-BUNDLE-1',
        name: 'Sale Bundle',
        type: 'BUNDLE',
        baseUomId: biz.uomId,
        bundleItems: [{ variantId: componentId, quantity: 2 }],
      })
      .expect(201);
    const bundleVariantId = bundle.body.data.variants[0].id;

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId: bundleVariantId, quantity: 3, unitPrice: 50 }], payments: [{ amount: 150 }] })
      .expect(201);

    const componentBalance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: componentId } });
    expect(Number(componentBalance.quantityOnHand)).toBe(44); // 50 - 3*2
  });

  it('COST VISIBILITY: an Owner (products.view_cost) sees totalCost/grossProfit on a sale; a Cashier does not', async () => {
    const cashierRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'CASHIER' } });
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: 'Cost Cashier', email: `costcashier@${biz.slug}.test`, password: 'CashierPass1!', roleIds: [cashierRole.id] })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `costcashier@${biz.slug}.test`, password: 'CashierPass1!', businessSlug: biz.slug })
      .expect(200);
    const cashierToken = login.body.data.accessToken;

    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SALE-COSTVIS-1');
    await stockUp(variantId, 10, 6);

    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 2, unitPrice: 10 }], payments: [{ amount: 20 }] })
      .expect(201);

    const ownerView = await request(app.getHttpServer()).get(`/api/v1/sales/${sale.body.data.id}`).set('Authorization', auth()).expect(200);
    expect(ownerView.body.data.totalCost).toBe('12'); // 2 * 6
    expect(ownerView.body.data.grossProfit).toBe('8'); // 20 - 12

    const cashierView = await request(app.getHttpServer())
      .get(`/api/v1/sales/${sale.body.data.id}`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(200);
    expect(cashierView.body.data.totalCost).toBeUndefined();
    expect(cashierView.body.data.grossProfit).toBeUndefined();
  });
});
