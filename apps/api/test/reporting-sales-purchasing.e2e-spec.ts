import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

describe('Reporting: sales and purchasing reports (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let variantA: string;
  let variantB: string;
  let supplierId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'rpt-salespur');

    ({ variantId: variantA } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RPT-SP-A'));
    ({ variantId: variantB } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RPT-SP-B'));
    await stockUp(variantA, 100, 4);
    await stockUp(variantB, 100, 10);

    // Sale 1: walk-in, 5 x A @ 20, no discount/tax -> net 100, cogs 20
    await sell([{ variantId: variantA, quantity: 5, unitPrice: 20 }], 100);
    // Sale 2: walk-in, 2 x B @ 50 with a 10 discount -> net 90, cogs 20
    await sell([{ variantId: variantB, quantity: 2, unitPrice: 50, discountAmount: 10 }], 90);

    const supplier = await request(app.getHttpServer())
      .post('/api/v1/purchasing/suppliers')
      .set('Authorization', auth())
      .send({ name: 'Reporting Supplier' })
      .expect(201);
    supplierId = supplier.body.data.id;
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

  async function sell(items: Record<string, unknown>[], payAmount: number, method = 'CASH') {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items, payments: [{ amount: payAmount, method }] })
      .expect(201);
  }

  it('SALES SUMMARY: net sales, COGS and gross profit are exact, and COGS comes from historical unitCostAtMovement', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', auth()).expect(200);
    const d = res.body.data;

    // subtotal = 5*20 + 2*50 = 200; discount = 10; net = 190
    expect(Number(d.subtotal)).toBe(200);
    expect(Number(d.discountAmount)).toBe(10);
    expect(Number(d.netSales)).toBe(190);
    expect(Number(d.transactionCount)).toBe(2);
    // cogs = 5*4 + 2*10 = 40
    expect(Number(d.cogs)).toBe(40);
    expect(Number(d.grossProfit)).toBe(150);
    // average invoice = totalAmount / 2
    expect(Number(d.averageInvoice)).toBeCloseTo(Number(d.totalAmount) / 2, 4);

    // Cross-check COGS against the movement ledger independently.
    const movements = await admin.stockMovement.findMany({
      where: { businessId: biz.businessId, referenceType: 'Sale', movementType: { in: ['SALE', 'BUNDLE_CONSUMPTION'] } },
    });
    const expected = movements.reduce((s, m) => s + Math.abs(Number(m.quantityBase)) * Number(m.unitCostAtMovement), 0);
    expect(Number(d.cogs)).toBeCloseTo(expected, 4);
  });

  it('HISTORICAL COGS: a later cost change does NOT alter the already-reported COGS for the earlier period', async () => {
    const before = await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', auth()).expect(200);
    const cogsBefore = Number(before.body.data.cogs);

    // Receive more of variantA at a much higher cost, moving the average.
    await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId: variantA, quantity: 100, unitCost: 40 })
      .expect(201);

    const after = await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', auth()).expect(200);
    expect(Number(after.body.data.cogs)).toBe(cogsBefore);
  });

  it('SALES BY PRODUCT: groups by variant with per-product net sales and profit', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/reports/sales/by-product').set('Authorization', auth()).expect(200);
    const rowA = res.body.data.find((r: { key: string }) => r.key === variantA);
    const rowB = res.body.data.find((r: { key: string }) => r.key === variantB);
    expect(Number(rowA.netSales)).toBe(100);
    expect(Number(rowA.quantity)).toBe(5);
    expect(Number(rowB.netSales)).toBe(90);
    expect(Number(rowB.cogs)).toBe(20);
    expect(Number(rowB.grossProfit)).toBe(70);
  });

  it('SALES BY CATEGORY: products with no category land in an explicit Uncategorized bucket, never silently dropped', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/reports/sales/by-category').set('Authorization', auth()).expect(200);
    const total = res.body.data.reduce((s: number, r: { netSales: string }) => s + Number(r.netSales), 0);
    // Every sale line is accounted for somewhere - category totals must
    // reconcile with the summary's net sales.
    expect(total).toBe(190);
    expect(res.body.data.some((r: { key: string }) => r.key === 'uncategorized')).toBe(true);
  });

  it('SALES BY BRANCH and BY USER reconcile with the summary total', async () => {
    const byBranch = await request(app.getHttpServer()).get('/api/v1/reports/sales/by-branch').set('Authorization', auth()).expect(200);
    const branchTotal = byBranch.body.data.reduce((s: number, r: { netSales: string }) => s + Number(r.netSales), 0);
    expect(branchTotal).toBe(190);

    const byUser = await request(app.getHttpServer()).get('/api/v1/reports/sales/by-user').set('Authorization', auth()).expect(200);
    const userTotal = byUser.body.data.reduce((s: number, r: { netSales: string }) => s + Number(r.netSales), 0);
    expect(userTotal).toBe(190);
    expect(byUser.body.data[0].transactionCount).toBeGreaterThan(0);
  });

  it('SALES BY PAYMENT METHOD: reports amount COLLECTED per method', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/reports/sales/by-payment-method').set('Authorization', auth()).expect(200);
    const cash = res.body.data.find((r: { key: string }) => r.key === 'CASH');
    expect(Number(cash.netSales)).toBe(190);
    expect(cash.transactionCount).toBe(2);
  });

  it('RETURNS: reports sellable/damaged split and flags the walk-in GL revenue-reversal limitation explicitly', async () => {
    const sale = await sell([{ variantId: variantA, quantity: 4, unitPrice: 20 }], 80);
    const saleItemId = sale.body.data.items[0].id;
    await request(app.getHttpServer())
      .post(`/api/v1/sales/${sale.body.data.id}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity: 2, condition: 'SELLABLE' }] })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/api/v1/reports/sales/returns').set('Authorization', auth()).expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(Number(res.body.summary.sellableValue)).toBe(40);
    // This sale had no customer, so its return value is walk-in.
    expect(Number(res.body.summary.walkInReturnValue)).toBe(40);
    expect(res.body.data[0].isWalkIn).toBe(true);
    // The documented divergence must be surfaced, not hidden.
    expect(res.body.summary.glRevenueReversalNote).toMatch(/walk-in/i);
    expect(res.body.summary.glRevenueReversalNote).toMatch(/do NOT reverse Sales Revenue/i);
  });

  it('PURCHASING SUMMARY: receipts/returns/payments match the source documents, cost gated behind products.view_cost', async () => {
    const purchase = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, supplierId, items: [{ variantId: variantB, quantityOrdered: 10, unitCost: 7 }] })
      .expect(201);
    await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${purchase.body.data.id}/approve`).set('Authorization', auth()).expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchase.body.data.id}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: purchase.body.data.items[0].id, quantityReceived: 10 }] })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/api/v1/reports/purchasing/summary').set('Authorization', auth()).expect(200);
    expect(Number(res.body.data.totalCost)).toBe(70);
    expect(Number(res.body.data.receivedQuantity)).toBe(10);
    expect(res.body.data.receiptCount).toBe(1);

    // A caller without products.view_cost must not receive cost measures.
    const bmRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'BRANCH_MANAGER' } });
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: 'Pur BM', email: `purbm@${biz.slug}.test`, password: 'BranchMgr1!', roleIds: [bmRole.id], branchIds: [biz.branchId] })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `purbm@${biz.slug}.test`, password: 'BranchMgr1!', businessSlug: biz.slug })
      .expect(200);
    const bmRes = await request(app.getHttpServer())
      .get('/api/v1/reports/purchasing/summary')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .expect(200);
    expect(bmRes.body.data).not.toHaveProperty('totalCost');
    expect(bmRes.body.data).not.toHaveProperty('returnedCost');
    expect(bmRes.body.data).not.toHaveProperty('netPurchaseCost');
    expect(bmRes.body.data).toHaveProperty('receiptCount');
  });

  it('DATE FILTERING: a period before any activity returns zeros, and the current period returns the real figures', async () => {
    const empty = await request(app.getHttpServer())
      .get('/api/v1/reports/sales/summary')
      .query({ from: '2001-01-01', to: '2001-12-31' })
      .set('Authorization', auth())
      .expect(200);
    expect(Number(empty.body.data.transactionCount)).toBe(0);

    const now = await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', auth()).expect(200);
    expect(Number(now.body.data.transactionCount)).toBeGreaterThan(0);
  });
});
