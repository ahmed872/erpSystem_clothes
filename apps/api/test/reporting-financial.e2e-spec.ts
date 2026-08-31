import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

describe('Reporting: financial reports - GL, P&L, Balance Sheet, AR/AP (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let variantId: string;
  let customerId: string;
  let supplierId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'rpt-financial');

    ({ variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RPT-FIN-1'));
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 100, unitCost: 6 })
      .expect(201);

    const customer = await request(app.getHttpServer())
      .post('/api/v1/sales/customers')
      .set('Authorization', auth())
      .send({ name: 'Financial Report Customer' })
      .expect(201);
    customerId = customer.body.data.id;

    // Cash sale: 5 @ 20 = 100 revenue, COGS 30.
    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 5, unitPrice: 20 }], payments: [{ amount: 100 }] })
      .expect(201);

    // Credit sale: 3 @ 20 = 60 revenue, COGS 18, paid 20 -> AR 40.
    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, customerId, items: [{ variantId, quantity: 3, unitPrice: 20 }], payments: [{ amount: 20 }] })
      .expect(201);

    const supplier = await request(app.getHttpServer())
      .post('/api/v1/purchasing/suppliers')
      .set('Authorization', auth())
      .send({ name: 'Financial Report Supplier' })
      .expect(201);
    supplierId = supplier.body.data.id;

    const purchase = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, supplierId, items: [{ variantId, quantityOrdered: 10, unitCost: 8 }] })
      .expect(201);
    await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${purchase.body.data.id}/approve`).set('Authorization', auth()).expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchase.body.data.id}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: purchase.body.data.items[0].id, quantityReceived: 10 }] })
      .expect(201);

    // A damage write-off, so operating expenses are non-zero.
    await request(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: -2, movementType: 'DAMAGE', reason: 'financial report test' })
      .expect(201);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  it('GENERAL LEDGER: returns posted journal lines with their account and source document', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/reports/financial/general-ledger').set('Authorization', auth()).expect(200);
    expect(res.body.pagination.total).toBeGreaterThan(0);
    const line = res.body.data[0];
    expect(line).toHaveProperty('entryNumber');
    expect(line).toHaveProperty('accountCode');
    expect(line).toHaveProperty('sourceType');
    // Every line is one-sided, per the double-entry invariant.
    expect(Number(line.debit) === 0 || Number(line.credit) === 0).toBe(true);
  });

  it('P&L: figures come from posted GL accounts and match an independent sum of journal lines', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/reports/financial/profit-and-loss').set('Authorization', auth()).expect(200);
    const d = res.body.data;

    // Revenue 100 + 60 = 160; COGS 5*6 + 3*6 = 48.
    expect(Number(d.netRevenue)).toBe(160);
    expect(Number(d.costOfGoodsSold)).toBe(48);
    expect(Number(d.grossProfit)).toBe(112);

    // Damage write-off of 2 units at avg cost -> non-zero shrinkage.
    expect(Number(d.inventoryRelatedOperatingExpenses.inventoryShrinkage)).toBeGreaterThan(0);
    expect(Number(d.netProfit)).toBeCloseTo(
      Number(d.grossProfit) - Number(d.inventoryRelatedOperatingExpenses.total) + Number(d.otherIncome),
      4,
    );

    // Independent cross-check straight from the journal lines.
    const revenueAccount = await admin.account.findFirstOrThrow({ where: { businessId: biz.businessId, code: '4100' } });
    const lines = await admin.journalEntryLine.findMany({ where: { businessId: biz.businessId, accountId: revenueAccount.id } });
    const netRevenue = lines.reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0);
    expect(Number(d.netRevenue)).toBeCloseTo(netRevenue, 4);
  });

  it('P&L: states its limitations explicitly - net revenue basis, inventory-only expenses, no discount line, walk-in returns', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/reports/financial/profit-and-loss').set('Authorization', auth()).expect(200);
    expect(res.body.limitations.revenueBasis).toMatch(/NET of sale returns/i);
    expect(res.body.limitations.operatingExpensesScope).toMatch(/INVENTORY-RELATED ONLY/i);
    expect(res.body.limitations.operatingExpensesScope).toMatch(/rent, salaries, utilities/i);
    expect(res.body.limitations.discounts).toMatch(/not a P&L line/i);
    // BEHAVIOURAL CORRECTION (Phase 10, BD-23): walk-in returns DO reverse
    // revenue now that the refund tender is recorded. See BD-23 and the
    // closure of Known Issue #32.
    expect(res.body.limitations.walkInReturns).toMatch(/DO reverse revenue/i);
    expect(res.body.limitations.walkInReturns).not.toMatch(/do NOT reverse revenue/i);
    expect(res.body.limitations.walkInReturns).toMatch(/before Phase 10/i);
    // The expense line must NOT be labelled as total business expenses.
    expect(res.body.data).toHaveProperty('inventoryRelatedOperatingExpenses');
    expect(res.body.data).not.toHaveProperty('totalExpenses');
  });

  it('BALANCE SHEET: BALANCES - Assets equals Liabilities + Equity including computed current-period earnings', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/reports/financial/balance-sheet').set('Authorization', auth()).expect(200);
    const d = res.body.data;

    expect(d.balanced).toBe(true);
    expect(Number(d.assets.total)).toBeCloseTo(Number(d.totalLiabilitiesAndEquity), 4);
    expect(Number(d.equity.total)).toBeCloseTo(Number(d.equity.currentPeriodEarnings), 4);
    expect(Number(d.assets.total)).toBeGreaterThan(0);

    // The identity must hold against independently-computed section totals.
    expect(Number(d.assets.total)).toBeCloseTo(Number(d.liabilities.total) + Number(d.equity.total), 4);
  });

  it('BALANCE SHEET: still balances after further activity (the invariant is structural, not a one-off)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 2, unitPrice: 25 }], payments: [{ amount: 50 }] })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/api/v1/reports/financial/balance-sheet').set('Authorization', auth()).expect(200);
    expect(res.body.data.balanced).toBe(true);
    expect(Number(res.body.data.assets.total)).toBeCloseTo(Number(res.body.data.totalLiabilitiesAndEquity), 4);
  });

  it('RECEIVABLES: per-customer balances match the append-only customer ledger, and aging is declared unavailable', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/reports/financial/receivables').set('Authorization', auth()).expect(200);
    const row = res.body.data.find((r: { customerId: string }) => r.customerId === customerId);
    // Credit sale 60, paid 20 -> owes 40.
    expect(Number(row.balance)).toBe(40);

    const txns = await admin.customerTransaction.findMany({ where: { businessId: biz.businessId, customerId } });
    const ledgerSum = txns.reduce((s, t) => s + Number(t.amount), 0);
    expect(Number(row.balance)).toBeCloseTo(ledgerSum, 4);

    expect(res.body.limitations.aging).toMatch(/not available/i);
  });

  it('PAYABLES: per-supplier balances match the append-only supplier ledger', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/reports/financial/payables').set('Authorization', auth()).expect(200);
    const row = res.body.data.find((r: { supplierId: string }) => r.supplierId === supplierId);
    expect(Number(row.balance)).toBe(80); // 10 received @ 8

    const txns = await admin.supplierTransaction.findMany({ where: { businessId: biz.businessId, supplierId } });
    const ledgerSum = txns.reduce((s, t) => s + Number(t.amount), 0);
    expect(Number(row.balance)).toBeCloseTo(ledgerSum, 4);
  });

  it('CASH FLOW is intentionally absent - no endpoint exists, because Investing/Financing have no source data', async () => {
    await request(app.getHttpServer()).get('/api/v1/reports/financial/cash-flow').set('Authorization', auth()).expect(404);
  });

  it('PERMISSIONS: a BRANCH_MANAGER (no reports.financial.view) is forbidden from every financial report', async () => {
    const bmRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'BRANCH_MANAGER' } });
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: 'Fin BM', email: `finbm@${biz.slug}.test`, password: 'BranchMgr1!', roleIds: [bmRole.id], branchIds: [biz.branchId] })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `finbm@${biz.slug}.test`, password: 'BranchMgr1!', businessSlug: biz.slug })
      .expect(200);
    const bmAuth = `Bearer ${login.body.data.accessToken}`;

    await request(app.getHttpServer()).get('/api/v1/reports/financial/profit-and-loss').set('Authorization', bmAuth).expect(403);
    await request(app.getHttpServer()).get('/api/v1/reports/financial/balance-sheet').set('Authorization', bmAuth).expect(403);
    await request(app.getHttpServer()).get('/api/v1/reports/financial/general-ledger').set('Authorization', bmAuth).expect(403);
    await request(app.getHttpServer()).get('/api/v1/reports/financial/receivables').set('Authorization', bmAuth).expect(403);
    await request(app.getHttpServer()).get('/api/v1/reports/financial/payables').set('Authorization', bmAuth).expect(403);
  });
});
