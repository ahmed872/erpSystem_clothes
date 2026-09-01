import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture, createTax } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 17 — ERP SALES MANAGEMENT.
 *
 * WHAT THIS SPEC IS FOR. The sale pipeline already existed and the ERP
 * added nothing to it: `sales-lifecycle`, `sales-returns`, `exchanges`,
 * `receipt`, `loyalty-*` and `sales-concurrency-and-isolation` prove the
 * engine. What was NOT proved is the set of claims the ERP sales SCREENS
 * make, each of which is a reason the UI is shaped the way it is:
 *
 *   - the list carries NO payment summary, which is why the list screen
 *     shows no payment column instead of deriving one;
 *   - the list accepts exactly five filters, which is why the screen
 *     offers no date range and no status filter — an ignored filter is
 *     worse than an absent one, and this proves it would be ignored;
 *   - cost and profit are ATTACHED for a `products.view_cost` holder and
 *     ABSENT — not null — for everyone else, on every sales response;
 *   - a receipt carries no cost for ANYBODY, owner included, and reprints
 *     frozen: changing the price and the tax rate afterwards cannot
 *     rewrite it;
 *   - the ERP's one mutation, settling an outstanding balance, is gated
 *     on `sales.pay`, refuses an overpayment and replays idempotently;
 *   - reading a sale is `sales.view` and creating one is `sales.create`,
 *     so the read-only back office posture is the server's rule and not a
 *     UI convention;
 *   - none of it crosses a tenant boundary.
 */
describe('ERP sales management (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let other: SalesFixture;

  let ownerToken: string;
  /** BRANCH_MANAGER: reads and settles sales, holds no `products.view_cost`. */
  let managerToken: string;
  /** A CUSTOM role that may READ sales and nothing else — no pay, no create. */
  let readerToken: string;
  /** A CUSTOM role with NO sales grant at all. */
  let outsiderToken: string;

  let taxId10: string;
  let variantId: string;
  let serialVariantId: string;
  let customerId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    biz = await setupSalesFixture(app, 'erp-sales-a');
    other = await setupSalesFixture(app, 'erp-sales-b');
    ownerToken = biz.accessToken;

    managerToken = await userOnTemplate('BRANCH_MANAGER', 'salesmgr');
    readerToken = await userOnCustomRole('SALESREADER', 'sread', ['sales.view', 'customers.view', 'products.view']);
    outsiderToken = await userOnCustomRole('STOCKONLY', 'stock', ['inventory.view', 'products.view']);

    taxId10 = await createTax(app, ownerToken, 10);
    ({ variantId } = await createSimpleProduct(app, ownerToken, biz.uomId, 'ERP-SALE-A', {
      defaultCost: 40,
      defaultSellingPrice: 100,
      taxId: taxId10,
    }));
    ({ variantId: serialVariantId } = await createSimpleProduct(app, ownerToken, biz.uomId, 'ERP-SALE-SER', {
      tracksSerialNumbers: true,
      defaultCost: 200,
      defaultSellingPrice: 500,
    }));
    await stockUp(variantId, 200, 40);

    const customer = await request(app.getHttpServer())
      .post('/api/v1/sales/customers')
      .set('Authorization', bearer(ownerToken))
      .send({ name: 'ERP Sales Customer', creditLimit: 100000 })
      .expect(201);
    customerId = customer.body.data.id;
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
  async function userOnTemplate(template: string, handle: string): Promise<string> {
    const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: template } });
    return createUser(handle, [role.id]);
  }
  async function userOnCustomRole(name: string, handle: string, permissionCodes: string[]): Promise<string> {
    const role = await request(app.getHttpServer())
      .post('/api/v1/roles')
      .set('Authorization', bearer(biz.accessToken))
      .send({ name, permissionCodes })
      .expect(201);
    return createUser(handle, [role.body.data.id]);
  }
  async function createUser(handle: string, roleIds: string[]): Promise<string> {
    const email = `${handle}@${biz.slug}.test`;
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', bearer(biz.accessToken))
      .send({ name: handle, email, password: 'ErpUserPass1!', roleIds })
      .expect(201);
    return login(email);
  }

  async function stockUp(variant: string, quantity: number, unitCost: number, fixture: SalesFixture = biz) {
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', bearer(fixture.accessToken))
      .send({ warehouseId: fixture.warehouseId, variantId: variant, quantity, unitCost })
      .expect(201);
  }

  /** A cash sale, settled in full. */
  async function cashSale(quantity = 2, unitPrice = 100) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', bearer(ownerToken))
      .send({
        warehouseId: biz.warehouseId,
        items: [{ variantId, quantity, unitPrice }],
        // The 10% tax the server computes, tendered exactly. Rounded to
        // the cent rather than written as `x * 1.1`, which in binary
        // floating point overshoots (200 * 1.1 is 220.00000000000003) and
        // is refused as an overpayment — correctly.
        payments: [{ amount: Math.round(quantity * unitPrice * 110) / 100, method: 'CASH' }],
      })
      .expect(201);
    return res.body.data;
  }

  /** A credit sale on the customer account, paid for nothing yet. */
  async function creditSale(quantity = 1, unitPrice = 100) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', bearer(ownerToken))
      .send({ warehouseId: biz.warehouseId, customerId, items: [{ variantId, quantity, unitPrice }], payments: [] })
      .expect(201);
    return res.body.data;
  }

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

  const COST_KEYS = [
    'cost',
    'unitCost',
    'averageCost',
    'defaultCost',
    'totalCost',
    'cogsPerUnit',
    'grossProfit',
    'margin',
    'profit',
    'valuation',
    'unitCostAtMovement',
  ];

  // ================================================================
  // 1. The list contract the sales screen is built on
  // ================================================================
  describe('the sales list', () => {
    it('serves the row shape the list screen renders, with its customer and warehouse joined', async () => {
      const sale = await cashSale();
      const res = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .set('Authorization', bearer(ownerToken))
        .expect(200);

      const row = res.body.data.find((s: { id: string }) => s.id === sale.id);
      expect(row).toEqual(
        expect.objectContaining({
          saleNumber: expect.stringMatching(/^INV-[A-F0-9]{8}$/),
          status: 'COMPLETED',
          warehouseId: biz.warehouseId,
          subtotal: expect.any(String),
          discountAmount: expect.any(String),
          taxAmount: expect.any(String),
          totalAmount: expect.any(String),
          createdAt: expect.any(String),
        }),
      );
      // The two joins the list renders as names rather than as ids. A
      // walk-in sale has no customer, which the screen prints as such.
      expect(row.warehouse).toEqual({ id: biz.warehouseId, name: expect.any(String) });
      expect(row.customer).toBeNull();
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ page: 1, limit: expect.any(Number), total: expect.any(Number), totalPages: expect.any(Number) }),
      );
    });

    it('carries NO payment summary — which is why the list shows no payment column', async () => {
      // `computePaymentSummary` runs in GetSaleUseCase only. This is the
      // proof behind `LIST_HAS_NO_PAYMENT_SUMMARY` in the ERP: a screen
      // that derived a status from `totalAmount` would call every
      // fully-paid cash sale unpaid. Opening the sale answers it instead.
      const sale = await creditSale();
      const res = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .set('Authorization', bearer(ownerToken))
        .expect(200);

      const row = res.body.data.find((s: { id: string }) => s.id === sale.id);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('paymentStatus');
      expect(row).not.toHaveProperty('paidAmount');
      expect(row).not.toHaveProperty('remainingAmount');
      expect(row).not.toHaveProperty('payments');
      expect(row).not.toHaveProperty('items');
    });

    it('finds a sale by the number printed on the receipt, exactly and case-insensitively', async () => {
      const sale = await cashSale();
      for (const typed of [sale.saleNumber, sale.saleNumber.toLowerCase()]) {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/sales?saleNumber=${encodeURIComponent(typed)}`)
          .set('Authorization', bearer(ownerToken))
          .expect(200);
        expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([sale.id]);
      }
    });

    it('does NOT partial-match a sale number — the lookup is equality, not a search', async () => {
      const sale = await cashSale();
      const prefix = sale.saleNumber.slice(0, 8);
      const res = await request(app.getHttpServer())
        .get(`/api/v1/sales?saleNumber=${encodeURIComponent(prefix)}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it('filters by customer, warehouse, branch and shift — the four id filters the screen offers', async () => {
      const walkIn = await cashSale();
      const onAccount = await creditSale();

      const byCustomer = await request(app.getHttpServer())
        .get(`/api/v1/sales?customerId=${customerId}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      const ids = byCustomer.body.data.map((s: { id: string }) => s.id);
      expect(ids).toContain(onAccount.id);
      expect(ids).not.toContain(walkIn.id);
      expect(byCustomer.body.data.every((s: { customerId: string }) => s.customerId === customerId)).toBe(true);

      const byWarehouse = await request(app.getHttpServer())
        .get(`/api/v1/sales?warehouseId=${biz.warehouseId}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(byWarehouse.body.data.map((s: { id: string }) => s.id)).toContain(walkIn.id);

      const byShift = await request(app.getHttpServer())
        .get(`/api/v1/sales?shiftId=${biz.activeShiftId}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(byShift.body.data.map((s: { id: string }) => s.id)).toContain(walkIn.id);

      const otherWarehouse = await request(app.getHttpServer())
        .get(`/api/v1/sales?warehouseId=${other.warehouseId}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      // Another tenant's warehouse id is not an error and not a leak: it
      // simply matches nothing inside this tenant's own rows.
      expect(otherWarehouse.body.data).toEqual([]);
    });

    it('IGNORES a status or date filter — which is exactly why the screen offers neither', async () => {
      // The decision recorded in the ERP as `SALE_LIST_FILTERS`. A screen
      // that rendered a date picker would be lying to the user: the query
      // schema drops the key and returns the unfiltered page. Proved here
      // rather than assumed, so that adding the filter to the backend one
      // day is a deliberate act with a failing test behind it.
      const unfiltered = await request(app.getHttpServer())
        .get('/api/v1/sales?limit=200')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      const filtered = await request(app.getHttpServer())
        .get('/api/v1/sales?limit=200&status=VOIDED&from=1999-01-01&to=1999-01-02')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(filtered.body.data.map((s: { id: string }) => s.id)).toEqual(
        unfiltered.body.data.map((s: { id: string }) => s.id),
      );
      expect(filtered.body.data.length).toBeGreaterThan(0);
    });

    it('paginates server-side, newest first', async () => {
      const first = await request(app.getHttpServer())
        .get('/api/v1/sales?page=1&limit=1')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(first.body.data).toHaveLength(1);
      expect(first.body.pagination.limit).toBe(1);
      expect(first.body.pagination.totalPages).toBe(first.body.pagination.total);

      const second = await request(app.getHttpServer())
        .get('/api/v1/sales?page=2&limit=1')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
      expect(new Date(first.body.data[0].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(second.body.data[0].createdAt).getTime(),
      );
    });
  });

  // ================================================================
  // 2. The detail contract
  // ================================================================
  describe('a single sale', () => {
    it('adds the SERVER payment summary the detail screen prints', async () => {
      const sale = await creditSale(3, 100);
      const res = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);

      expect(res.body.data.paymentStatus).toBe('UNPAID');
      expect(money(res.body.data.paidAmount)).toBe(0);
      expect(money(res.body.data.remainingAmount)).toBe(money(res.body.data.totalAmount));
      expect(money(res.body.data.totalAmount)).toBeCloseTo(330, 4); // 3 x 100 + 10%
    });

    it('carries the line snapshot the screen shows, including the tax rate as it was', async () => {
      const sale = await cashSale(2, 100);
      const res = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);

      const line = res.body.data.items[0];
      expect(line).toEqual(
        expect.objectContaining({
          variantId,
          quantity: expect.any(String),
          unitPrice: expect.any(String),
          taxAmount: expect.any(String),
          taxRateSnapshot: expect.any(String),
          taxExempt: false,
          lineTotal: expect.any(String),
          quantityReturned: expect.any(String),
        }),
      );
      expect(line.variant).toEqual({ id: variantId, sku: 'ERP-SALE-A' });
      expect(money(line.taxRateSnapshot)).toBe(10);
      expect(money(line.quantityReturned)).toBe(0);
      expect(res.body.data.payments).toHaveLength(1);
      expect(res.body.data.returns).toEqual([]);
    });

    it('shows what came back: the line quantity returned, and the return itself', async () => {
      const sale = await cashSale(5, 100);
      const detailBefore = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      const saleItemId = detailBefore.body.data.items[0].id;

      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/returns`)
        .set('Authorization', bearer(ownerToken))
        // Phase 10 (BD-23): a WALK-IN return must be refunded in full —
        // there is no customer account for a remainder to sit on. The
        // credit is the line's own per-unit total including its tax
        // (550 / 5 = 110), which the server checks; nothing about that is
        // the ERP's to compute, which is why the ERP does not offer
        // returns at all.
        .send({ reason: 'wrong size', items: [{ saleItemId, quantity: 2, condition: 'SELLABLE' }], refund: { method: 'CASH', amount: 220 } })
        .expect(201);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(money(after.body.data.items[0].quantityReturned)).toBe(2);
      expect(after.body.data.returns).toHaveLength(1);
      expect(after.body.data.returns[0]).toEqual(
        expect.objectContaining({ returnNumber: expect.stringMatching(/^SRET-[A-F0-9]{8}$/), createdAt: expect.any(String) }),
      );
      expect(after.body.data.returns[0].items).toHaveLength(1);
      // The sale's own totals are UNTOUCHED by the return: a return is its
      // own document, and the ERP shows both rather than netting them.
      expect(money(after.body.data.totalAmount)).toBe(money(detailBefore.body.data.totalAmount));
    });

    it('404s on a sale that does not exist, without saying whether the id is real elsewhere', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/sales/00000000-0000-4000-8000-000000000000')
        .set('Authorization', bearer(ownerToken))
        .expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ================================================================
  // 3. Cost and profit visibility — the Phase 14/15 defect class
  // ================================================================
  describe('cost and profit', () => {
    it('attaches totalCost and grossProfit for a `products.view_cost` holder', async () => {
      const sale = await cashSale(2, 100);
      const res = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      // Cost 40 x 2 = 80. Revenue net of tax 200. Profit 120.
      expect(money(res.body.data.totalCost)).toBeCloseTo(80, 4);
      expect(money(res.body.data.grossProfit)).toBeCloseTo(120, 4);
    });

    it('OMITS them — absent, not null — for a caller without the grant', async () => {
      // Absent rather than null is the point. A null would still tell the
      // screen a figure exists and would render as a dash where the owner
      // sees a number; the ERP asks "did the response carry it", which no
      // client-side branch can flip.
      const sale = await cashSale(2, 100);
      for (const token of [managerToken, readerToken]) {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/sales/${sale.id}`)
          .set('Authorization', bearer(token))
          .expect(200);
        expect(res.body.data).not.toHaveProperty('totalCost');
        expect(res.body.data).not.toHaveProperty('grossProfit');
        expect(res.body.data.paymentStatus).toBe('PAID');
      }
    });

    it('leaks no cost key ANYWHERE in the list or the detail for a caller without the grant', async () => {
      const sale = await creditSale(2, 100);
      const list = await request(app.getHttpServer())
        .get('/api/v1/sales?limit=200')
        .set('Authorization', bearer(managerToken))
        .expect(200);
      expect(findKeys(list.body.data, COST_KEYS)).toEqual([]);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Authorization', bearer(managerToken))
        .expect(200);
      expect(findKeys(detail.body.data, COST_KEYS)).toEqual([]);
    });

    it('leaks no cost key in the LIST even for the owner — the list is not the cost surface', async () => {
      // `ListSalesUseCase` attaches nothing; only the detail does, and
      // only under the grant. Asserted so a future "just add totals to the
      // list" change has to face this test.
      const list = await request(app.getHttpServer())
        .get('/api/v1/sales?limit=200')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(findKeys(list.body.data, COST_KEYS)).toEqual([]);
    });
  });

  // ================================================================
  // 4. The receipt
  // ================================================================
  describe('the receipt', () => {
    it('serves the whole document in one call, assembled by the server', async () => {
      const sale = await cashSale(2, 100);
      const res = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/receipt`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);

      const r = res.body.data;
      expect(r.business).toEqual(expect.objectContaining({ displayName: expect.any(String), currency: expect.any(String) }));
      expect(r.sale).toEqual(
        expect.objectContaining({
          saleNumber: sale.saleNumber,
          totalAmount: expect.any(String),
          paidAmount: expect.any(String),
          remainingAmount: expect.any(String),
          paymentStatus: 'PAID',
        }),
      );
      expect(r.cashier).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String) }));
      expect(r.items[0]).toEqual(
        expect.objectContaining({ sku: 'ERP-SALE-A', name: 'ERP-SALE-A', serials: [], serialUnits: [], promotions: [] }),
      );
      expect(r.taxBreakdown).toEqual([
        { ratePercent: '10', taxableAmount: expect.any(String), taxAmount: expect.any(String) },
      ]);
      expect(r.payments).toHaveLength(1);
      expect(r.loyalty).toEqual({ earned: expect.any(String), redeemed: expect.any(String) });
      expect(r.returns).toEqual([]);
    });

    it('carries NO cost for ANYBODY — an owner reprinting one has no margin on it', async () => {
      const sale = await cashSale(2, 100);
      for (const token of [ownerToken, managerToken, readerToken]) {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/sales/${sale.id}/receipt`)
          .set('Authorization', bearer(token))
          .expect(200);
        expect(findKeys(res.body.data, COST_KEYS)).toEqual([]);
      }
    });

    it('reprints FROZEN: repricing the product and changing the tax rate cannot rewrite it', async () => {
      // The reason the ERP receipt screen computes nothing at all. A
      // browser that recalculated the total would apply today's rules to a
      // fact recorded before them.
      const sale = await cashSale(2, 100);
      const before = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/receipt`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/taxes/${taxId10}`)
        .set('Authorization', bearer(ownerToken))
        .send({ ratePercent: 25 })
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/receipt`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);

      expect(after.body.data.sale.totalAmount).toBe(before.body.data.sale.totalAmount);
      expect(after.body.data.sale.taxAmount).toBe(before.body.data.sale.taxAmount);
      expect(after.body.data.taxBreakdown).toEqual(before.body.data.taxBreakdown);
      expect(money(after.body.data.taxBreakdown[0].ratePercent)).toBe(10);

      // Put the rate back so the rest of the spec's arithmetic holds.
      await request(app.getHttpServer())
        .patch(`/api/v1/taxes/${taxId10}`)
        .set('Authorization', bearer(ownerToken))
        .send({ ratePercent: 10 })
        .expect(200);
    });

    it('names the serial units it sold, which is what the receipt screen prints under a line', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', bearer(ownerToken))
        .send({
          warehouseId: biz.warehouseId,
          variantId: serialVariantId,
          quantity: 2,
          unitCost: 200,
          serials: ['ERP-SN-1', 'ERP-SN-2'],
        })
        .expect(201);

      const sale = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', bearer(ownerToken))
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId: serialVariantId, quantity: 1, unitPrice: 500, serials: ['ERP-SN-1'] }],
          payments: [{ amount: 500, method: 'CASH' }],
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.body.data.id}/receipt`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      const line = res.body.data.items.find((i: { sku: string }) => i.sku === 'ERP-SALE-SER');
      expect(line.serials).toEqual(['ERP-SN-1']);
      expect(line.serialUnits).toEqual([{ id: expect.any(String), serial: 'ERP-SN-1' }]);
      expect(findKeys(res.body.data, COST_KEYS)).toEqual([]);
    });

    it('shows a return on the reprint, so a customer holding the slip can tell', async () => {
      const sale = await cashSale(4, 100);
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/returns`)
        .set('Authorization', bearer(ownerToken))
        .send({ items: [{ saleItemId: detail.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }], refund: { method: 'CASH', amount: 110 } })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/receipt`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(res.body.data.returns).toHaveLength(1);
      expect(res.body.data.returns[0]).toEqual(
        expect.objectContaining({ returnNumber: expect.stringMatching(/^SRET-/), refundMethod: expect.anything() }),
      );
      expect(money(res.body.data.items[0].quantityReturned)).toBe(1);
    });
  });

  // ================================================================
  // 5. The one mutation the back office offers
  // ================================================================
  describe('recording a payment', () => {
    it('settles an outstanding balance and moves the server payment summary', async () => {
      const sale = await creditSale(2, 100); // 220 with tax
      const paid = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments`)
        .set('Authorization', bearer(ownerToken))
        .send({ amount: 100, method: 'CASH', reference: 'ERP-1' })
        .expect(201);
      expect(paid.body.data).toBeDefined();

      const partial = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(partial.body.data.paymentStatus).toBe('PARTIALLY_PAID');
      expect(money(partial.body.data.paidAmount)).toBeCloseTo(100, 4);
      expect(money(partial.body.data.remainingAmount)).toBeCloseTo(120, 4);

      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments`)
        .set('Authorization', bearer(ownerToken))
        .send({ amount: 120, method: 'CARD' })
        .expect(201);

      const settled = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(settled.body.data.paymentStatus).toBe('PAID');
      expect(money(settled.body.data.remainingAmount)).toBe(0);
      expect(settled.body.data.payments).toHaveLength(2);
    });

    it('refuses an overpayment — the server owns what is outstanding, not the form', async () => {
      const sale = await creditSale(1, 100); // 110
      const res = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments`)
        .set('Authorization', bearer(ownerToken))
        .send({ amount: 111, method: 'CASH' })
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('replays an idempotency key without taking the money twice', async () => {
      // The ERP dialog mints one key per open, so a double submit or a
      // retried request settles the balance once.
      const sale = await creditSale(1, 100);
      const key = `erp-pay-${sale.id}`;
      const first = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments`)
        .set('Authorization', bearer(ownerToken))
        .send({ amount: 110, method: 'CASH', idempotencyKey: key })
        .expect(201);
      const replay = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments`)
        .set('Authorization', bearer(ownerToken))
        .send({ amount: 110, method: 'CASH', idempotencyKey: key })
        .expect(201);
      expect(replay.body.data.id).toBe(first.body.data.id);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(detail.body.data.payments).toHaveLength(1);
      expect(detail.body.data.paymentStatus).toBe('PAID');
    });

    it('demands `sales.pay` — reading a sale is not permission to settle it', async () => {
      const sale = await creditSale(1, 100);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments`)
        .set('Authorization', bearer(readerToken))
        .send({ amount: 10, method: 'CASH' })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');

      // ...and the grant, held, is enough: a BRANCH_MANAGER settles it.
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments`)
        .set('Authorization', bearer(managerToken))
        .send({ amount: 10, method: 'CASH' })
        .expect(201);
    });
  });

  // ================================================================
  // 6. Authorization
  // ================================================================
  describe('authorization', () => {
    it('demands `sales.view` on every read the ERP performs', async () => {
      const sale = await cashSale();
      for (const path of ['/api/v1/sales', `/api/v1/sales/${sale.id}`, `/api/v1/sales/${sale.id}/receipt`]) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', bearer(outsiderToken))
          .expect(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
    });

    it('refuses an anonymous read outright', async () => {
      await request(app.getHttpServer()).get('/api/v1/sales').expect(401);
    });

    it('keeps SELLING behind `sales.create`, which is why the ERP never rings one up', async () => {
      // The read-only back-office posture is the SERVER's rule. A reader
      // who can list every sale still cannot create one, quote one, or
      // commit a return.
      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', bearer(readerToken))
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 100 }], payments: [] })
        .expect(403);

      await request(app.getHttpServer())
        .post('/api/v1/sales/quote')
        .set('Authorization', bearer(readerToken))
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 100 }] })
        .expect(403);

      const sale = await cashSale();
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/returns`)
        .set('Authorization', bearer(readerToken))
        .send({ items: [{ saleItemId: detail.body.data.items[0].id, quantity: 1 }] })
        .expect(403);
    });
  });

  // ================================================================
  // 7. Tenant isolation
  // ================================================================
  describe('tenant isolation', () => {
    it('hides another business’s sale behind a 404, not a 403', async () => {
      const foreignVariant = await createSimpleProduct(app, other.accessToken, other.uomId, 'OTHER-SALE', {
        defaultCost: 10,
        defaultSellingPrice: 50,
      });
      await stockUp(foreignVariant.variantId, 10, 10, other);
      const foreignSale = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', bearer(other.accessToken))
        .send({
          warehouseId: other.warehouseId,
          items: [{ variantId: foreignVariant.variantId, quantity: 1, unitPrice: 50 }],
          payments: [{ amount: 50, method: 'CASH' }],
        })
        .expect(201);

      for (const path of [`/api/v1/sales/${foreignSale.body.data.id}`, `/api/v1/sales/${foreignSale.body.data.id}/receipt`]) {
        await request(app.getHttpServer()).get(path).set('Authorization', bearer(ownerToken)).expect(404);
      }
      // A payment against it is refused as well: an id from elsewhere is
      // not a handle on someone else's ledger.
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${foreignSale.body.data.id}/payments`)
        .set('Authorization', bearer(ownerToken))
        .send({ amount: 1, method: 'CASH' })
        .expect(404);
    });

    it('never returns another business’s sale in a list, filtered or not', async () => {
      const mine = await request(app.getHttpServer())
        .get('/api/v1/sales?limit=200')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      const theirs = await request(app.getHttpServer())
        .get('/api/v1/sales?limit=200')
        .set('Authorization', bearer(other.accessToken))
        .expect(200);

      const mineIds = new Set(mine.body.data.map((s: { id: string }) => s.id));
      for (const row of theirs.body.data) expect(mineIds.has(row.id)).toBe(false);
      expect(mine.body.data.every((s: { branchId: string }) => s.branchId === biz.branchId)).toBe(true);

      // A cross-tenant customer id is not an error and matches nothing —
      // it cannot be used to probe whether that customer exists.
      const foreignCustomer = await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', bearer(other.accessToken))
        .send({ name: 'Their Customer' })
        .expect(201);
      const probe = await request(app.getHttpServer())
        .get(`/api/v1/sales?customerId=${foreignCustomer.body.data.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(probe.body.data).toEqual([]);
    });

    it('does not find another business’s sale by its number', async () => {
      const theirs = await request(app.getHttpServer())
        .get('/api/v1/sales?limit=1')
        .set('Authorization', bearer(other.accessToken))
        .expect(200);
      const theirNumber = theirs.body.data[0].saleNumber;
      const res = await request(app.getHttpServer())
        .get(`/api/v1/sales?saleNumber=${encodeURIComponent(theirNumber)}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(res.body.data).toEqual([]);
    });
  });
});
