import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

describe('Reporting: dashboard and reconciliation (e2e, real Postgres)', () => {
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
    biz = await setupSalesFixture(app, 'rpt-dash');

    ({ variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RPT-DASH-1'));
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 100, unitCost: 5 })
      .expect(201);

    const customer = await request(app.getHttpServer())
      .post('/api/v1/sales/customers')
      .set('Authorization', auth())
      .send({ name: 'Dashboard Customer' })
      .expect(201);
    customerId = customer.body.data.id;

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 6, unitPrice: 20 }], payments: [{ amount: 120 }] })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, customerId, items: [{ variantId, quantity: 4, unitPrice: 20 }], payments: [{ amount: 30 }] })
      .expect(201);

    const supplier = await request(app.getHttpServer())
      .post('/api/v1/purchasing/suppliers')
      .set('Authorization', auth())
      .send({ name: 'Dashboard Supplier' })
      .expect(201);
    supplierId = supplier.body.data.id;
    const purchase = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, supplierId, items: [{ variantId, quantityOrdered: 20, unitCost: 6 }] })
      .expect(201);
    await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${purchase.body.data.id}/approve`).set('Authorization', auth()).expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchase.body.data.id}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: purchase.body.data.items[0].id, quantityReceived: 20 }] })
      .expect(201);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  describe('Dashboard', () => {
    it('returns KPIs consistent with the underlying source systems', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/reports/dashboard').set('Authorization', auth()).expect(200);
      const k = res.body.data.kpis;

      expect(k.transactions).toBe(2);
      expect(Number(k.netSales)).toBe(200); // 6*20 + 4*20
      expect(Number(k.cogs)).toBe(50); // 10 units @ 5
      expect(Number(k.grossProfit)).toBe(150);
      expect(Number(k.totalCost)).toBe(120); // 20 received @ 6
      // Credit sale: 80 owed, 30 paid -> 50 receivable.
      expect(Number(k.receivables)).toBe(50);
      expect(Number(k.payables)).toBe(120);
      expect(Number(k.inventoryValue)).toBeGreaterThan(0);

      // Cross-check inventory value independently against the balance cache.
      const balances = await admin.stockBalance.findMany({ where: { businessId: biz.businessId } });
      const expected = balances.reduce((s, b) => s + Number(b.quantityOnHand) * Number(b.averageCost), 0);
      expect(Number(k.inventoryValue)).toBeCloseTo(expected, 4);
    });

    it('labels expenses as INVENTORY-RELATED ONLY and never as total business expenses', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/reports/dashboard').set('Authorization', auth()).expect(200);
      expect(res.body.data.kpis).toHaveProperty('inventoryRelatedOperatingExpenses');
      expect(res.body.data.kpis).not.toHaveProperty('totalExpenses');
      expect(res.body.data.kpis).not.toHaveProperty('expenses');
      expect(res.body.limitations.expenses).toMatch(/INVENTORY SHRINKAGE AND INTERNAL CONSUMPTION|inventory shrinkage and internal consumption/i);
      expect(res.body.limitations.expenses).toMatch(/not a total-expenses figure/i);
      expect(res.body.limitations.netProfit).toMatch(/not a complete business profit/i);
      expect(res.body.limitations.cashAndBank).toMatch(/not a complete treasury position/i);
      expect(res.body.limitations.lowStock).toMatch(/no reorder-point/i);
    });

    it('returns top and slowest products', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/reports/dashboard').set('Authorization', auth()).expect(200);
      expect(res.body.data.topProducts.length).toBeGreaterThan(0);
      expect(res.body.data.topProducts[0]).toHaveProperty('sku');
      expect(res.body.data.slowestProducts.length).toBeGreaterThan(0);
    });

    it('strips profit/cost KPIs for a caller without the permissions', async () => {
      const bmRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'BRANCH_MANAGER' } });
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'Dash BM', email: `dashbm@${biz.slug}.test`, password: 'BranchMgr1!', roleIds: [bmRole.id], branchIds: [biz.branchId] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `dashbm@${biz.slug}.test`, password: 'BranchMgr1!', businessSlug: biz.slug })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/dashboard')
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .expect(200);
      expect(res.body.data.kpis).not.toHaveProperty('grossProfit');
      expect(res.body.data.kpis).not.toHaveProperty('netProfit');
      expect(res.body.data.kpis).not.toHaveProperty('cogs');
      expect(res.body.data.kpis).not.toHaveProperty('totalCost');
      expect(res.body.data.kpis).not.toHaveProperty('inventoryValue');
      expect(res.body.data.kpis).toHaveProperty('netSales');
      expect(res.body.data.kpis).toHaveProperty('transactions');
    });

    it('creates NO dashboard tables - the KPIs are a live read model', async () => {
      const tables = await admin.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name LIKE '%dashboard%' OR table_name LIKE '%report%' OR table_name LIKE '%kpi%')`,
      );
      expect(tables).toHaveLength(0);
    });
  });

  describe('Reconciliation', () => {
    it('#1 INVENTORY LEDGER vs BALANCE reconciles exactly, with zero tolerance', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/reconciliation/inventory-ledger')
        .set('Authorization', auth())
        .expect(200);
      expect(res.body.summary.reconciled).toBe(true);
      expect(res.body.summary.discrepancyCount).toBe(0);
      expect(res.body.summary.expectedRelationship).toMatch(/zero tolerance/i);
    });

    it('#2 CUSTOMER LEDGER vs AR control account reconciles exactly', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/reports/reconciliation/customer-ar').set('Authorization', auth()).expect(200);
      expect(res.body.summary.reconciled).toBe(true);
      expect(Number(res.body.summary.delta)).toBe(0);
      expect(Number(res.body.summary.subledgerTotal)).toBe(50);
      expect(Number(res.body.summary.controlAccountBalance)).toBe(50);
    });

    it('#3 SUPPLIER LEDGER vs AP control account reconciles exactly', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/reports/reconciliation/supplier-ap').set('Authorization', auth()).expect(200);
      expect(res.body.summary.reconciled).toBe(true);
      expect(Number(res.body.summary.delta)).toBe(0);
      expect(Number(res.body.summary.subledgerTotal)).toBe(120);
    });

    it('#4 INVENTORY vs GL reconciles once the documented non-posting movements are excluded, and both exclusions are reported explicitly', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/reports/reconciliation/inventory-gl').set('Authorization', auth()).expect(200);
      expect(res.body.summary.reconciled).toBe(true);
      expect(Number(res.body.summary.delta)).toBe(0);

      const stockCountExclusion = res.body.summary.exclusions.find((e: { excludedBy: string }) => e.excludedBy.includes('StockCount'));
      const openingExclusion = res.body.summary.exclusions.find((e: { excludedBy: string }) => e.excludedBy.includes('OPENING_BALANCE'));
      expect(stockCountExclusion).toBeDefined();
      expect(openingExclusion).toBeDefined();

      // Opening stock exists in this fixture and is deliberately unposted.
      expect(openingExclusion.excludedMovementCount).toBeGreaterThan(0);
      expect(Number(openingExclusion.excludedValue)).toBeGreaterThan(0);
      expect(openingExclusion.reason).toMatch(/EXPECTED and is NOT an accounting error/i);
    });

    it('#4 STOCK-COUNT DIVERGENCE: stock-count approval writes ADJUSTMENT/referenceType=StockCount (the STOCK_COUNT movement type is never written), and its value is excluded VISIBLY while the comparison still reconciles', async () => {
      const { variantId: countVariant } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RPT-DASH-COUNT');
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId: countVariant, quantity: 50, unitCost: 10 })
        .expect(201);

      const count = await request(app.getHttpServer())
        .post('/api/v1/inventory/stock-counts')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantIds: [countVariant] })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/api/v1/inventory/stock-counts/${count.body.data.id}/items`)
        .set('Authorization', auth())
        .send({ items: [{ variantId: countVariant, actualQuantity: 45, reason: 'reporting stock count test' }] })
        .expect(200);
      await request(app.getHttpServer()).post(`/api/v1/inventory/stock-counts/${count.body.data.id}/submit`).set('Authorization', auth()).expect(200);
      await request(app.getHttpServer()).post(`/api/v1/inventory/stock-counts/${count.body.data.id}/approve`).set('Authorization', auth()).expect(200);

      // The STOCK_COUNT movement TYPE is dead - no code writes it.
      const byType = await admin.stockMovement.findMany({ where: { businessId: biz.businessId, movementType: 'STOCK_COUNT' } });
      expect(byType).toHaveLength(0);

      // The real stock-count movements carry referenceType 'StockCount'
      // with movementType ADJUSTMENT, and have no journal entry.
      const byReference = await admin.stockMovement.findMany({ where: { businessId: biz.businessId, referenceType: 'StockCount' } });
      expect(byReference.length).toBeGreaterThan(0);
      expect(byReference[0].movementType).toBe('ADJUSTMENT');
      const entriesForCount = await admin.journalEntry.findMany({
        where: { businessId: biz.businessId, sourceType: 'StockMovement', sourceId: { in: byReference.map((m) => m.id) } },
      });
      expect(entriesForCount).toHaveLength(0);

      const res = await request(app.getHttpServer()).get('/api/v1/reports/reconciliation/inventory-gl').set('Authorization', auth()).expect(200);
      const exclusion = res.body.summary.exclusions.find((e: { excludedBy: string }) => e.excludedBy.includes('StockCount'));

      // The exclusion is VISIBLE and quantified - never silently dropped.
      expect(exclusion.excludedMovementCount).toBe(byReference.length);
      expect(Number(exclusion.excludedValue)).not.toBe(0);
      expect(exclusion.reason).toMatch(/produce no General Ledger entry/i);
      expect(exclusion.reason).toMatch(/EXPECTED and is NOT an accounting error/i);
      expect(exclusion.reason).toMatch(/never written by any code path/i);

      // With the documented exclusions applied, the comparison still
      // reconciles - proving the divergence is entirely attributable to
      // those limitations and nothing else.
      expect(res.body.summary.reconciled).toBe(true);
      expect(Number(res.body.summary.delta)).toBe(0);
      expect(res.body.summary.note).toMatch(/expected, documented limitations/i);
    });

    it('reconciliation reports respect permission boundaries', async () => {
      const cashierRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'CASHIER' } });
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'Recon Cashier', email: `reconcashier@${biz.slug}.test`, password: 'CashierPass1!', roleIds: [cashierRole.id] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `reconcashier@${biz.slug}.test`, password: 'CashierPass1!', businessSlug: biz.slug })
        .expect(200);
      const cashierAuth = `Bearer ${login.body.data.accessToken}`;

      await request(app.getHttpServer()).get('/api/v1/reports/reconciliation/inventory-ledger').set('Authorization', cashierAuth).expect(403);
      await request(app.getHttpServer()).get('/api/v1/reports/reconciliation/customer-ar').set('Authorization', cashierAuth).expect(403);
      await request(app.getHttpServer()).get('/api/v1/reports/dashboard').set('Authorization', cashierAuth).expect(403);
    });

    it('CASH REGISTER reconciliation is intentionally absent - neither CashRegister nor CashTransaction exists', async () => {
      await request(app.getHttpServer()).get('/api/v1/reports/reconciliation/cash-register').set('Authorization', auth()).expect(404);
    });
  });
});
