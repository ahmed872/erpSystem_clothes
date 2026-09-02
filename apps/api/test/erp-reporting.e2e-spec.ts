import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 19 — ERP REPORTING & ANALYTICS.
 *
 * WHAT THIS SPEC IS FOR. The reporting engine already existed and the ERP
 * added nothing; `reporting-{dashboard-reconciliation,financial,inventory,
 * sales-purchasing,isolation-and-permissions}` prove the aggregates and
 * the branch scoping. What those 1,047 lines do NOT prove is the set of
 * claims the ERP report SCREENS make — and, more importantly, the one
 * behaviour Phase 19's contract discovery found to be entirely untested:
 *
 * ═══ THE OWNER DECISION, PINNED HERE ═══
 *
 * `reports.financial.view` IMPLIES visibility of the financial reports'
 * own contents, profit lines included. `reports.view_profit` is NOT an
 * additional gate inside that family.
 *
 * The reasoning, recorded so a future reader does not mistake it for an
 * oversight: a Profit & Loss without `grossProfit` is a document with its
 * purpose removed, and the General Ledger under the same grant already
 * exposes the COGS journal lines from which profit is trivially
 * derivable — so gating the statement while leaving the ledger open would
 * buy nothing.
 *
 * Discovery found `financial-reports.use-case.ts` and
 * `reconciliation.use-case.ts` never call `applyVisibility`, while every
 * other reporting use-case does. That asymmetry is now a DECIDED
 * behaviour with tests behind it rather than an untested accident. If
 * anyone later adds field stripping to the financial family, these cases
 * fail and the decision has to be revisited deliberately.
 *
 * The decision is scoped to that family ALONE: the sales, purchasing,
 * inventory and dashboard reports still strip cost and profit, and this
 * spec asserts that too, in both directions.
 */
describe('ERP reporting (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let other: SalesFixture;

  let ownerToken: string;
  /** BRANCH_MANAGER: sales + inventory reports, NO financial, NO cost/profit. */
  let managerToken: string;
  /**
   * The role the owner decision is really about: every report READ grant,
   * and NEITHER `products.view_cost` NOR `reports.view_profit`. No seeded
   * template looks like this — it is reachable only through a custom
   * role, which this product treats as first-class.
   */
  let financeOnlyToken: string;
  /** A caller with no reporting grant at all. */
  let outsiderToken: string;

  let variantId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    biz = await setupSalesFixture(app, 'erp-rpt-a');
    other = await setupSalesFixture(app, 'erp-rpt-b');
    ownerToken = biz.accessToken;

    managerToken = await userOnTemplate('BRANCH_MANAGER', 'rptmgr', [biz.branchId]);
    financeOnlyToken = await userOnCustomRole('FINONLY', 'finonly', [
      'reports.financial.view',
      'reports.sales.view',
      'reports.inventory.view',
      'reports.dashboard.view',
    ]);
    outsiderToken = await userOnCustomRole('NOREPORTS', 'outsider', ['inventory.view', 'products.view']);

    ({ variantId } = await createSimpleProduct(app, ownerToken, biz.uomId, 'RPT-A', { defaultCost: 40, defaultSellingPrice: 100 }));
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', bearer(ownerToken))
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 100, unitCost: 40 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', bearer(ownerToken))
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 3, unitPrice: 100 }], payments: [{ amount: 300, method: 'CASH' }] })
      .expect(201);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const bearer = (t: string) => `Bearer ${t}`;
  const money = (v: unknown) => Number(v);

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'ErpUserPass1!', businessSlug: biz.slug })
      .expect(200);
    return res.body.data.accessToken;
  }
  async function userOnTemplate(template: string, handle: string, branchIds?: string[]): Promise<string> {
    const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: template } });
    return createUser(handle, [role.id], branchIds);
  }
  async function userOnCustomRole(name: string, handle: string, permissionCodes: string[]): Promise<string> {
    const role = await request(app.getHttpServer())
      .post('/api/v1/roles')
      .set('Authorization', bearer(biz.accessToken))
      .send({ name, permissionCodes })
      .expect(201);
    return createUser(handle, [role.body.data.id]);
  }
  async function createUser(handle: string, roleIds: string[], branchIds?: string[]): Promise<string> {
    const email = `${handle}@${biz.slug}.test`;
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', bearer(biz.accessToken))
      .send({ name: handle, email, password: 'ErpUserPass1!', roleIds, ...(branchIds ? { branchIds } : {}) })
      .expect(201);
    return login(email);
  }

  const get = (path: string, token: string) => request(app.getHttpServer()).get(`/api/v1${path}`).set('Authorization', bearer(token));

  /** Deep search for any key in an object graph. */
  function findKeys(value: unknown, keys: string[], path = ''): string[] {
    const hits: string[] = [];
    const walk = (v: unknown, p: string) => {
      if (v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (keys.includes(k)) hits.push(`${p}.${k}`);
        walk(val, `${p}.${k}`);
      }
    };
    walk(value, path);
    return hits;
  }

  const FINANCIAL_ROUTES = [
    '/reports/financial/general-ledger',
    '/reports/financial/profit-and-loss',
    '/reports/financial/balance-sheet',
    '/reports/financial/receivables',
    '/reports/financial/payables',
    '/reports/reconciliation/customer-ar',
    '/reports/reconciliation/supplier-ap',
    '/reports/reconciliation/inventory-gl',
  ];

  // ================================================================
  // 1. THE OWNER DECISION
  // ================================================================
  describe('the financial family — `reports.financial.view` implies its contents', () => {
    it('serves the Profit & Loss to a holder of the grant ALONE, profit lines included', async () => {
      const res = await get('/reports/financial/profit-and-loss', financeOnlyToken).expect(200);
      // The three fields the decision is about, present and non-null for
      // a caller holding NEITHER `products.view_cost` NOR
      // `reports.view_profit`.
      expect(res.body.data).toHaveProperty('costOfGoodsSold');
      expect(res.body.data).toHaveProperty('grossProfit');
      expect(res.body.data).toHaveProperty('netProfit');
      expect(money(res.body.data.netRevenue)).toBeCloseTo(300, 4);
      expect(money(res.body.data.costOfGoodsSold)).toBeCloseTo(120, 4);
      expect(money(res.body.data.grossProfit)).toBeCloseTo(180, 4);
    });

    it('serves that caller the SAME statement the owner sees, field for field', async () => {
      // The decision in its strongest form: the grant is the boundary, so
      // there is no second, reduced version of the document.
      const asOwner = await get('/reports/financial/profit-and-loss', ownerToken).expect(200);
      const asFinance = await get('/reports/financial/profit-and-loss', financeOnlyToken).expect(200);
      expect(asFinance.body.data).toEqual(asOwner.body.data);
    });

    it('serves the Balance Sheet, current-period earnings included', async () => {
      const res = await get('/reports/financial/balance-sheet', financeOnlyToken).expect(200);
      expect(res.body.data.equity).toHaveProperty('currentPeriodEarnings');
      expect(money(res.body.data.equity.currentPeriodEarnings)).toBeCloseTo(180, 4);
      // The server's own equation check, which the screen renders rather
      // than recomputing.
      expect(res.body.data.balanced).toBe(true);
    });

    it('serves the General Ledger, which is why gating the statement alone would buy nothing', async () => {
      // The reasoning behind the decision, asserted as fact: the same
      // grant hands over the COGS journal lines, from which profit is
      // derivable regardless of what the P&L shows.
      const res = await get('/reports/financial/general-ledger', financeOnlyToken).expect(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0]).toEqual(
        expect.objectContaining({ entryNumber: expect.any(String), accountCode: expect.any(String), debit: expect.any(String) }),
      );
      const accounts = res.body.data.map((r: { accountName: string }) => r.accountName);
      expect(accounts.some((n: string) => /cost of goods sold/i.test(n))).toBe(true);
    });

    it('serves the financial reconciliation reports under the same grant', async () => {
      for (const path of ['/reports/reconciliation/customer-ar', '/reports/reconciliation/supplier-ap', '/reports/reconciliation/inventory-gl']) {
        const res = await get(path, financeOnlyToken).expect(200);
        expect(res.body.summary).toEqual(expect.objectContaining({ sourceA: expect.any(String), sourceB: expect.any(String) }));
      }
    });

    it('serves receivables and payables under the same grant', async () => {
      for (const path of ['/reports/financial/receivables', '/reports/financial/payables']) {
        const res = await get(path, financeOnlyToken).expect(200);
        expect(res.body).toHaveProperty('pagination');
        expect(res.body).toHaveProperty('summary');
      }
    });
  });

  // ================================================================
  // 2. THE DECISION IS SCOPED TO THAT FAMILY ALONE
  // ================================================================
  describe('everywhere else, cost and profit are still stripped', () => {
    it('removes them — absent, not null — from the sales summary for the SAME caller', async () => {
      // The proof that the owner decision did not become a blanket
      // exemption: this caller reads the whole P&L and is still refused
      // the operational COGS figure.
      const res = await get('/reports/sales/summary', financeOnlyToken).expect(200);
      expect(res.body.data).toHaveProperty('netSales');
      expect(res.body.data).not.toHaveProperty('cogs');
      expect(res.body.data).not.toHaveProperty('grossProfit');
    });

    it('removes them from the dashboard, the by-dimension rows and the purchasing summary', async () => {
      const dashboard = await get('/reports/dashboard', financeOnlyToken).expect(200);
      for (const key of ['totalCost', 'cogs', 'grossProfit', 'netProfit', 'inventoryValue']) {
        expect(dashboard.body.data.kpis).not.toHaveProperty(key);
      }
      // ...while the operational KPIs remain.
      expect(dashboard.body.data.kpis).toHaveProperty('netSales');
      expect(dashboard.body.data.kpis).toHaveProperty('transactions');

      const byProduct = await get('/reports/sales/by-product', financeOnlyToken).expect(200);
      for (const row of byProduct.body.data) {
        expect(row).not.toHaveProperty('cogs');
        expect(row).not.toHaveProperty('grossProfit');
        expect(row).toHaveProperty('netSales');
      }

      const purchasing = await get('/reports/purchasing/summary', financeOnlyToken).expect(200);
      expect(purchasing.body.data).not.toHaveProperty('totalCost');
      expect(purchasing.body.data).not.toHaveProperty('netPurchaseCost');
      expect(purchasing.body.data).toHaveProperty('receiptCount');
    });

    it('removes them from every inventory report for a BRANCH_MANAGER', async () => {
      const valuation = await get('/reports/inventory/valuation', managerToken).expect(200);
      expect(valuation.body.data[0]).not.toHaveProperty('averageCost');
      expect(valuation.body.data[0]).not.toHaveProperty('inventoryValue');
      expect(valuation.body.data[0]).toHaveProperty('quantityOnHand');
      expect(valuation.body.summary).not.toHaveProperty('inventoryValue');

      const movements = await get('/reports/inventory/movements', managerToken).expect(200);
      expect(movements.body.data[0]).not.toHaveProperty('unitCostAtMovement');
      expect(movements.body.data[0]).not.toHaveProperty('movementValue');

      const slow = await get('/reports/inventory/slow-moving?days=1', managerToken).expect(200);
      for (const row of slow.body.data) {
        expect(row).not.toHaveProperty('averageCost');
        expect(row).not.toHaveProperty('inventoryValue');
      }
    });

    it('gives the OWNER those same figures — the stripping is the grant, not the endpoint', async () => {
      const summary = await get('/reports/sales/summary', ownerToken).expect(200);
      expect(money(summary.body.data.cogs)).toBeCloseTo(120, 4);
      expect(money(summary.body.data.grossProfit)).toBeCloseTo(180, 4);

      const valuation = await get('/reports/inventory/valuation', ownerToken).expect(200);
      expect(valuation.body.data[0]).toHaveProperty('inventoryValue');
      expect(valuation.body.summary).toHaveProperty('inventoryValue');
    });
  });

  // ================================================================
  // 3. Permission boundaries
  // ================================================================
  describe('permission boundaries', () => {
    it('refuses a BRANCH_MANAGER every financial route — the matrix, unchanged', async () => {
      for (const path of FINANCIAL_ROUTES) {
        const res = await get(path, managerToken).expect(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
    });

    it('still admits a BRANCH_MANAGER to the sales, inventory and inventory-ledger reports', async () => {
      // The reason `/reports/reconciliation` is reachable on EITHER report
      // grant in the ERP: the inventory ledger is `reports.inventory.view`
      // while its three siblings are financial.
      for (const path of [
        '/reports/sales/summary',
        '/reports/sales/by-product',
        '/reports/inventory/valuation',
        '/reports/reconciliation/inventory-ledger',
        '/reports/dashboard',
      ]) {
        await get(path, managerToken).expect(200);
      }
    });

    it('refuses a caller with no reporting grant every reporting route', async () => {
      for (const path of [
        '/reports/dashboard',
        '/reports/sales/summary',
        '/reports/purchasing/summary',
        '/reports/inventory/valuation',
        '/reports/reconciliation/inventory-ledger',
        ...FINANCIAL_ROUTES,
      ]) {
        await get(path, outsiderToken).expect(403);
      }
    });

    it('refuses an anonymous caller outright', async () => {
      await request(app.getHttpServer()).get('/api/v1/reports/financial/profit-and-loss').expect(401);
      await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').expect(401);
    });

    it('keeps purchasing’s summary under the SALES grant, not under `purchases.view`', async () => {
      // Which is why the ERP's purchasing-report route asks for
      // `reports.sales.view`. Asserted so the guard cannot drift.
      const buyer = await userOnCustomRole('BUYERONLY', 'buyer', ['purchases.view', 'suppliers.view']);
      await get('/reports/purchasing/summary', buyer).expect(403);
      await get('/reports/purchasing/summary', managerToken).expect(200);
    });
  });

  // ================================================================
  // 4. Tenant isolation, including the financial family
  // ================================================================
  describe('tenant isolation', () => {
    beforeAll(async () => {
      // Give the other tenant a distinguishable revenue figure.
      const foreign = await createSimpleProduct(app, other.accessToken, other.uomId, 'RPT-B', {
        defaultCost: 7,
        defaultSellingPrice: 4321,
      });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', bearer(other.accessToken))
        .send({ warehouseId: other.warehouseId, variantId: foreign.variantId, quantity: 10, unitCost: 7 })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', bearer(other.accessToken))
        .send({
          warehouseId: other.warehouseId,
          items: [{ variantId: foreign.variantId, quantity: 1, unitPrice: 4321 }],
          payments: [{ amount: 4321, method: 'CASH' }],
        })
        .expect(201);
    });

    it('never shows one tenant’s figures in another’s financial reports', async () => {
      // The existing suite proves this for the SALES reports only; the
      // financial family was unproven until Phase 19.
      for (const path of FINANCIAL_ROUTES) {
        const mine = JSON.stringify((await get(path, ownerToken).expect(200)).body);
        expect(mine).not.toContain('4321');
      }

      // A POSITIVE control on the three reports where that revenue must
      // actually appear, so the assertion above cannot pass merely
      // because every report came back empty. Receivables, payables and
      // the reconciliations are deliberately NOT in this list: the other
      // tenant's sale was a walk-in paid in cash, so it leaves no
      // receivable — an empty report there is the correct answer, not
      // evidence of isolation.
      for (const path of ['/reports/financial/profit-and-loss', '/reports/financial/general-ledger', '/reports/financial/balance-sheet']) {
        const theirs = JSON.stringify((await get(path, other.accessToken).expect(200)).body);
        expect(theirs).toContain('4321');
      }
    });

    it('never shows one tenant’s figures in another’s dashboard or sales reports', async () => {
      for (const path of ['/reports/dashboard', '/reports/sales/summary', '/reports/sales/by-product']) {
        const mine = JSON.stringify((await get(path, ownerToken).expect(200)).body);
        expect(mine).not.toContain('4321');
      }
    });

    it('rejects another tenant’s branchId as not-found, never leaking that it exists', async () => {
      const res = await get(`/reports/dashboard?branchId=${other.branchId}`, ownerToken).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ================================================================
  // 5. The contract facts the ERP screens are shaped around
  // ================================================================
  describe('the parameter contract the screens rely on', () => {
    it('resolves the window in the BUSINESS timezone and echoes the half-open range it used', async () => {
      const res = await get('/reports/sales/summary?from=2026-01-15&to=2026-01-15', ownerToken).expect(200);
      // One whole calendar day: the exclusive bound is the START of the
      // next day, which is why the screen labels `to` as exclusive.
      const from = new Date(res.body.range.from);
      const to = new Date(res.body.range.to);
      expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
      expect(res.body.range.timezone).toBe('Africa/Cairo');
    });

    it('rejects an inverted range rather than returning an empty period', async () => {
      const res = await get('/reports/sales/summary?from=2026-09-02&to=2026-09-01', ownerToken).expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('IGNORES a groupBy or comparison parameter — which is why neither control exists', async () => {
      const plain = await get('/reports/sales/summary', ownerToken).expect(200);
      const decorated = await get('/reports/sales/summary?groupBy=day&compareTo=lastMonth&interval=week', ownerToken).expect(200);
      expect(decorated.body.data).toEqual(plain.body.data);
    });

    it('ACCEPTS `branchId` on the P&L and ignores it — which is why no branch picker is offered', async () => {
      const withBranch = await get(`/reports/financial/profit-and-loss?branchId=${biz.branchId}`, ownerToken).expect(200);
      const without = await get('/reports/financial/profit-and-loss', ownerToken).expect(200);
      expect(withBranch.body.data).toEqual(without.body.data);
    });

    it('honours `warehouseId` on by-product and IGNORES it on by-user and by-payment-method', async () => {
      // The reason the ERP shows a warehouse picker on two of the five
      // breakdowns and an explanation on the other three.
      const FAKE = '00000000-0000-4000-8000-000000000000';
      const productReal = await get(`/reports/sales/by-product?warehouseId=${biz.warehouseId}`, ownerToken).expect(200);
      const productFake = await get(`/reports/sales/by-product?warehouseId=${FAKE}`, ownerToken).expect(200);
      expect(productReal.body.data).not.toEqual(productFake.body.data);

      for (const dimension of ['by-user', 'by-payment-method']) {
        const real = await get(`/reports/sales/${dimension}?warehouseId=${biz.warehouseId}`, ownerToken).expect(200);
        const fake = await get(`/reports/sales/${dimension}?warehouseId=${FAKE}`, ownerToken).expect(200);
        expect(real.body.data).toEqual(fake.body.data);
      }
    });

    it('DROPS a date range on the rangeless reports — which is why they show no date control', async () => {
      for (const path of ['/reports/inventory/valuation', '/reports/financial/receivables', '/reports/financial/payables']) {
        const plain = await get(path, ownerToken).expect(200);
        const dated = await get(`${path}?from=2020-01-01&to=2020-01-02`, ownerToken).expect(200);
        expect(dated.body.data).toEqual(plain.body.data);
      }
    });

    it('reports `by-user` quantity and cost as an AUTHORITATIVE zero, not as missing data', async () => {
      // The server groups whole Sale rows, which carry no per-line
      // quantity or cost. The ERP says so rather than printing three
      // zeros a reader would take as fact.
      const res = await get('/reports/sales/by-user', ownerToken).expect(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const row of res.body.data) {
        expect(row.quantity).toBe('0');
        expect(row.cogs).toBe('0');
        expect(row.grossProfit).toBe('0');
        expect(Number(row.netSales)).toBeGreaterThan(0);
      }
    });

    it('states its own definition of "slow" rather than leaving the ERP to invent one', async () => {
      const res = await get('/reports/inventory/slow-moving?days=30', ownerToken).expect(200);
      expect(res.body.criteria).toEqual({ days: 30, definition: expect.stringContaining('no SALE') });
    });

    it('states in prose what its figures do NOT include, on every report that has a caveat', async () => {
      // The ERP prints these verbatim rather than paraphrasing them.
      for (const [path, key] of [
        ['/reports/dashboard', 'netProfit'],
        ['/reports/financial/profit-and-loss', 'operatingExpensesScope'],
        ['/reports/financial/balance-sheet', 'currentPeriodEarnings'],
        ['/reports/financial/receivables', 'aging'],
      ] as [string, string][]) {
        const res = await get(path, ownerToken).expect(200);
        expect(typeof res.body.limitations[key]).toBe('string');
        expect(res.body.limitations[key].length).toBeGreaterThan(20);
      }
    });

    it('carries no cost key anywhere in a report a caller may not see cost in', async () => {
      const COST_KEYS = ['totalCost', 'unitCost', 'averageCost', 'inventoryValue', 'cogs', 'returnedCost', 'netPurchaseCost', 'unitCostAtMovement', 'movementValue'];
      const PROFIT_KEYS = ['grossProfit', 'marginPercent', 'profit'];
      for (const path of [
        '/reports/sales/summary',
        '/reports/sales/by-product',
        '/reports/sales/by-category',
        '/reports/purchasing/summary',
        '/reports/inventory/valuation',
        '/reports/inventory/movements',
        '/reports/inventory/damage-loss',
        '/reports/inventory/slow-moving',
      ]) {
        const res = await get(path, managerToken).expect(200);
        expect(findKeys(res.body.data, COST_KEYS)).toEqual([]);
        expect(findKeys(res.body.data, PROFIT_KEYS)).toEqual([]);
        if (res.body.summary) expect(findKeys(res.body.summary, [...COST_KEYS, ...PROFIT_KEYS])).toEqual([]);
      }
    });
  });
});
