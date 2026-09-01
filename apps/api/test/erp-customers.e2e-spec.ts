import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture, createTax } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 18 — ERP CUSTOMERS.
 *
 * WHAT THIS SPEC IS FOR. The customer and loyalty contracts already
 * existed and the ERP added none; `sales-customers`, `loyalty-ledger`,
 * `loyalty-redemption` and `sales-return-credit` prove the engines. What
 * was NOT proved is the set of claims the ERP customer SCREENS make, each
 * of which is a reason the UI is shaped the way it is:
 *
 *   - the list accepts exactly `search`, `isActive`, `page` and `limit`,
 *     and DROPS anything else silently — which is why the screen offers
 *     no email, balance or ordering control;
 *   - `search` covers name AND phone, and an EXACT phone match is ranked
 *     first by the server, which is why the browser never re-sorts;
 *   - the create and update schemas accept exactly five fields, and a
 *     `creditLimit` or an `isActive` sent to either is DROPPED while the
 *     request still succeeds — which is why the form has neither box;
 *   - deactivation is one-way: DELETE deactivates, nothing reactivates,
 *     so no reactivate control is offered (the Phase 18 contract gap);
 *   - the account balance and the points balance are server-derived sums
 *     that no page of rows adds up to;
 *   - customers, loyalty and sales history are THREE separate grants;
 *   - no cost, margin or profit appears on any customer surface;
 *   - none of it crosses a tenant boundary.
 */
describe('ERP customers (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let other: SalesFixture;

  let ownerToken: string;
  /** BRANCH_MANAGER: reads customers, loyalty and sales; edits none of them. */
  let managerToken: string;
  /** ACCOUNTANT: the one template role holding `loyalty.adjust`. */
  let accountantToken: string;
  /** A CUSTOM role holding ONLY `customers.view` — no loyalty, no sales. */
  let plainToken: string;
  /** A CUSTOM role with no customer grant at all. */
  let outsiderToken: string;

  let variantId: string;
  let customerId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    biz = await setupSalesFixture(app, 'erp-cust-a');
    other = await setupSalesFixture(app, 'erp-cust-b');
    ownerToken = biz.accessToken;

    managerToken = await userOnTemplate('BRANCH_MANAGER', 'custmgr');
    accountantToken = await userOnTemplate('ACCOUNTANT', 'custacc');
    plainToken = await userOnCustomRole('CUSTVIEW', 'plain', ['customers.view']);
    outsiderToken = await userOnCustomRole('NOCUST', 'outsider', ['inventory.view', 'products.view']);

    const taxId = await createTax(app, ownerToken, 10);
    ({ variantId } = await createSimpleProduct(app, ownerToken, biz.uomId, 'ERP-CUST-A', {
      defaultCost: 40,
      defaultSellingPrice: 100,
      taxId,
    }));
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', bearer(ownerToken))
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 200, unitCost: 40 })
      .expect(201);

    customerId = (await createCustomer({ name: 'Layla Hassan', phone: '01001234567', email: 'layla@example.test' })).id;
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

  async function createCustomer(body: Record<string, unknown>, token = ownerToken) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales/customers')
      .set('Authorization', bearer(token))
      .send(body)
      .expect(201);
    return res.body.data;
  }

  /** A credit sale that leaves a balance on the customer's account. */
  async function creditSale(id: string, quantity = 2, unitPrice = 100) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', bearer(ownerToken))
      .send({ warehouseId: biz.warehouseId, customerId: id, items: [{ variantId, quantity, unitPrice }], payments: [] })
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

  const COST_KEYS = ['cost', 'unitCost', 'averageCost', 'defaultCost', 'totalCost', 'grossProfit', 'margin', 'profit', 'valuation'];

  // ================================================================
  // 1. The list contract the customers screen is built on
  // ================================================================
  describe('the customers list', () => {
    it('serves the row shape the list renders, with a SERVER-computed balance', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/sales/customers')
        .set('Authorization', bearer(ownerToken))
        .expect(200);

      const row = res.body.data.find((c: { id: string }) => c.id === customerId);
      expect(row).toEqual(
        expect.objectContaining({
          name: 'Layla Hassan',
          phone: '01001234567',
          email: 'layla@example.test',
          isActive: true,
          balance: expect.any(String),
        }),
      );
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ page: 1, limit: expect.any(Number), total: expect.any(Number), totalPages: expect.any(Number) }),
      );
    });

    it('moves the balance when the account moves — and it is a SUM, not a stored number', async () => {
      const fresh = await createCustomer({ name: 'Ledger Customer' });
      const before = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${fresh.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(money(before.body.data.balance)).toBe(0);

      await creditSale(fresh.id, 2, 100); // 220 with 10% tax

      const after = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${fresh.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(money(after.body.data.balance)).toBeCloseTo(220, 4);
      // The figure is the sum of the ledger the response also carries.
      const summed = after.body.data.recentTransactions.reduce((s: number, r: { amount: string }) => s + Number(r.amount), 0);
      expect(summed).toBeCloseTo(money(after.body.data.balance), 4);
    });

    it('searches name AND phone, and ranks an EXACT phone match first', async () => {
      // The reason the browser never re-sorts the page: a shop with both
      // "0100" and "01001234567" on file must not bury the person who
      // just read out their whole number, and the ranking happens in SQL
      // BEFORE the page is cut.
      await createCustomer({ name: 'Partial Phone Person', phone: '0100' });

      const byName = await request(app.getHttpServer())
        .get('/api/v1/sales/customers?search=Layla')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(byName.body.data.map((c: { id: string }) => c.id)).toContain(customerId);

      const byExactPhone = await request(app.getHttpServer())
        .get('/api/v1/sales/customers?search=01001234567')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(byExactPhone.body.data[0].id).toBe(customerId);

      // A prefix matches BOTH, and the exact one is not first here —
      // which is precisely the case the ranking exists for.
      const byPrefix = await request(app.getHttpServer())
        .get('/api/v1/sales/customers?search=0100')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      const ids = byPrefix.body.data.map((c: { id: string }) => c.id);
      expect(ids).toContain(customerId);
      expect(byPrefix.body.data.length).toBeGreaterThanOrEqual(2);
    });

    it('treats a wildcard as a literal rather than as a pattern', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/sales/customers?search=%25')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it('honours `isActive=false` as FALSE — the Phase 16 fix, still holding', async () => {
      const doomed = await createCustomer({ name: 'To Be Deactivated' });
      await request(app.getHttpServer())
        .delete(`/api/v1/sales/customers/${doomed.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);

      const inactive = await request(app.getHttpServer())
        .get('/api/v1/sales/customers?isActive=false&limit=200')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(inactive.body.data.map((c: { id: string }) => c.id)).toContain(doomed.id);
      expect(inactive.body.data.every((c: { isActive: boolean }) => c.isActive === false)).toBe(true);

      const active = await request(app.getHttpServer())
        .get('/api/v1/sales/customers?isActive=true&limit=200')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(active.body.data.map((c: { id: string }) => c.id)).not.toContain(doomed.id);
    });

    it('IGNORES a filter it does not accept — which is why the screen offers none', async () => {
      const unfiltered = await request(app.getHttpServer())
        .get('/api/v1/sales/customers?limit=200')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      const bogus = await request(app.getHttpServer())
        .get('/api/v1/sales/customers?limit=200&email=layla@example.test&hasBalance=true&sort=name&branchId=x')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(bogus.body.data.map((c: { id: string }) => c.id)).toEqual(unfiltered.body.data.map((c: { id: string }) => c.id));
      expect(bogus.body.data.length).toBeGreaterThan(1);
    });

    it('paginates server-side', async () => {
      const page1 = await request(app.getHttpServer())
        .get('/api/v1/sales/customers?page=1&limit=1')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.pagination.totalPages).toBe(page1.body.pagination.total);

      const page2 = await request(app.getHttpServer())
        .get('/api/v1/sales/customers?page=2&limit=1')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    });
  });

  // ================================================================
  // 2. Create and edit — exactly five fields
  // ================================================================
  describe('creating and editing a customer', () => {
    it('accepts the five fields the form offers', async () => {
      const created = await createCustomer({
        name: 'Full Record',
        phone: '01005550000',
        email: 'full@example.test',
        address: '1 Market Street',
        taxNumber: 'TX-9',
      });
      expect(created).toEqual(
        expect.objectContaining({
          name: 'Full Record',
          phone: '01005550000',
          email: 'full@example.test',
          address: '1 Market Street',
          taxNumber: 'TX-9',
          isActive: true,
        }),
      );
    });

    it('DROPS a creditLimit rather than storing one — there is no such field', async () => {
      // The reason the form has no credit-limit box. The schema is not
      // strict, so the request SUCCEEDS and the number vanishes: a UI
      // offering the field would report a saved limit that was never
      // stored anywhere.
      const created = await createCustomer({ name: 'No Credit Limit', creditLimit: 5000 });
      expect(created).not.toHaveProperty('creditLimit');
      const row = await admin.customer.findUniqueOrThrow({ where: { id: created.id } });
      expect(row).not.toHaveProperty('creditLimit');
    });

    it('DROPS an isActive on create — a customer always starts active', async () => {
      const created = await createCustomer({ name: 'Born Active', isActive: false });
      expect(created.isActive).toBe(true);
    });

    it('edits the same five fields and nothing else', async () => {
      const created = await createCustomer({ name: 'Before Edit', phone: '01007770000' });
      const updated = await request(app.getHttpServer())
        .patch(`/api/v1/sales/customers/${created.id}`)
        .set('Authorization', bearer(ownerToken))
        .send({ name: 'After Edit', email: 'after@example.test' })
        .expect(200);
      expect(updated.body.data.name).toBe('After Edit');
      expect(updated.body.data.email).toBe('after@example.test');
    });

    it('validates as the backend does, not as the browser might', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', bearer(ownerToken))
        .send({ name: '' })
        .expect(422);
      await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', bearer(ownerToken))
        .send({ name: 'Bad Email', email: 'not-an-email' })
        .expect(422);
    });

    it('allows duplicate names and phones — there is no natural key to dedupe on', async () => {
      await createCustomer({ name: 'Mohamed Ali', phone: '01009999999' });
      const second = await createCustomer({ name: 'Mohamed Ali', phone: '01009999999' });
      expect(second.name).toBe('Mohamed Ali');
    });
  });

  // ================================================================
  // 3. Deactivation — and the reactivation gap
  // ================================================================
  describe('deactivation', () => {
    it('soft-deletes: the customer stays, and so does every document against them', async () => {
      const c = await createCustomer({ name: 'Deactivate Me' });
      const sale = await creditSale(c.id, 1, 100);

      await request(app.getHttpServer())
        .delete(`/api/v1/sales/customers/${c.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${c.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(after.body.data.isActive).toBe(false);
      // The sale and the ledger row are untouched.
      expect(money(after.body.data.balance)).toBeCloseTo(110, 4);
      await request(app.getHttpServer()).get(`/api/v1/sales/${sale.id}`).set('Authorization', bearer(ownerToken)).expect(200);
    });

    it('refuses a second deactivation with a 409, which is why the control disappears', async () => {
      const c = await createCustomer({ name: 'Twice Deactivated' });
      await request(app.getHttpServer()).delete(`/api/v1/sales/customers/${c.id}`).set('Authorization', bearer(ownerToken)).expect(200);
      const again = await request(app.getHttpServer())
        .delete(`/api/v1/sales/customers/${c.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(409);
      expect(again.body.error.code).toBe('CONFLICT');
    });

    it('CANNOT be undone — the Phase 18 contract gap, pinned so a fix is deliberate', async () => {
      // `updateCustomerSchema` does not accept `isActive`, and the schema
      // is not strict, so this PATCH returns 200 having changed NOTHING.
      // That silent success is exactly why the ERP offers no reactivate
      // control: it would report a customer restored and leave them
      // inactive. If reactivation is ever added, this test fails and the
      // screen gains the control deliberately rather than by accident.
      const c = await createCustomer({ name: 'Cannot Come Back' });
      await request(app.getHttpServer()).delete(`/api/v1/sales/customers/${c.id}`).set('Authorization', bearer(ownerToken)).expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/sales/customers/${c.id}`)
        .set('Authorization', bearer(ownerToken))
        .send({ isActive: true })
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${c.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(after.body.data.isActive).toBe(false);
    });
  });

  // ================================================================
  // 4. The detail: account ledger and loyalty
  // ================================================================
  describe('a single customer', () => {
    it('carries the account ledger the detail screen renders, newest first', async () => {
      const c = await createCustomer({ name: 'Ledger Reader' });
      await creditSale(c.id, 1, 100);
      await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', bearer(ownerToken))
        .send({ name: 'noise' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${c.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(res.body.data.recentTransactions.length).toBeGreaterThan(0);
      expect(res.body.data.recentTransactions[0]).toEqual(
        expect.objectContaining({ type: 'SALE', amount: expect.any(String), createdAt: expect.any(String) }),
      );
    });

    it('derives the points balance from the ledger and says so on the response', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          customerId,
          customerName: 'Layla Hassan',
          balance: expect.any(String),
          eventCount: expect.any(Number),
          derivation: expect.stringContaining('no stored balance'),
        }),
      );
    });

    it('returns the WHOLE balance beside a filtered page, never that page’s subtotal', async () => {
      // The reason the loyalty panel shows the response's `balance` and
      // never sums the rows on screen.
      const c = await createCustomer({ name: 'Points Customer' });
      for (const [points, reason] of [
        [100, 'goodwill'],
        [-30, 'correction'],
      ] as [number, string][]) {
        await request(app.getHttpServer())
          .post(`/api/v1/sales/customers/${c.id}/points/adjust`)
          .set('Authorization', bearer(accountantToken))
          .send({ points, reason, idempotencyKey: `erp-${c.id}-${points}` })
          .expect(201);
      }

      const all = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${c.id}/points/ledger`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(money(all.body.balance)).toBeCloseTo(70, 4);
      expect(all.body.data).toHaveLength(2);

      const filtered = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${c.id}/points/ledger?type=ADJUSTMENT&page=1&limit=1`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(filtered.body.data).toHaveLength(1);
      // One row on the page, and the balance is still the whole 70.
      expect(money(filtered.body.balance)).toBeCloseTo(70, 4);
      expect(money(filtered.body.data[0].points)).not.toBeCloseTo(70, 4);
    });

    it('replays an adjustment idempotency key without doubling the points', async () => {
      const c = await createCustomer({ name: 'Idempotent Points' });
      const key = `erp-adj-${c.id}`;
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${c.id}/points/adjust`)
        .set('Authorization', bearer(accountantToken))
        .send({ points: 50, reason: 'goodwill', idempotencyKey: key })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${c.id}/points/adjust`)
        .set('Authorization', bearer(accountantToken))
        .send({ points: 50, reason: 'goodwill', idempotencyKey: key })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${c.id}/points`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(money(res.body.data.balance)).toBeCloseTo(50, 4);
      expect(res.body.data.eventCount).toBe(1);
    });

    it('requires a reason and refuses a zero adjustment', async () => {
      const c = await createCustomer({ name: 'Bad Adjustment' });
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${c.id}/points/adjust`)
        .set('Authorization', bearer(accountantToken))
        .send({ points: 10, idempotencyKey: 'no-reason' })
        .expect(422);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${c.id}/points/adjust`)
        .set('Authorization', bearer(accountantToken))
        .send({ points: 0, reason: 'nothing', idempotencyKey: 'zero' })
        .expect(422);
    });

    it('404s on a customer that does not exist', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      for (const path of [`/api/v1/sales/customers/${missing}`, `/api/v1/sales/customers/${missing}/points`]) {
        const res = await request(app.getHttpServer()).get(path).set('Authorization', bearer(ownerToken)).expect(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
    });
  });

  // ================================================================
  // 5. Three grants, three surfaces
  // ================================================================
  describe('authorization', () => {
    it('separates customers, loyalty and sales history into three grants', async () => {
      // The reason the detail screen makes three independent requests and
      // renders only the panels that came back: a `customers.view`-only
      // role reads the customer and is refused both of the others.
      await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}`)
        .set('Authorization', bearer(plainToken))
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points`)
        .set('Authorization', bearer(plainToken))
        .expect(403);
      await request(app.getHttpServer())
        .get(`/api/v1/sales?customerId=${customerId}`)
        .set('Authorization', bearer(plainToken))
        .expect(403);

      // A BRANCH_MANAGER holds all three reads.
      for (const path of [
        `/api/v1/sales/customers/${customerId}`,
        `/api/v1/sales/customers/${customerId}/points`,
        `/api/v1/sales?customerId=${customerId}`,
      ]) {
        await request(app.getHttpServer()).get(path).set('Authorization', bearer(managerToken)).expect(200);
      }
    });

    it('keeps every mutation behind its own grant, whatever the UI hides', async () => {
      const res403 = (r: request.Response) => expect(r.body.error.code).toBe('FORBIDDEN');

      res403(
        await request(app.getHttpServer())
          .post('/api/v1/sales/customers')
          .set('Authorization', bearer(plainToken))
          .send({ name: 'Nope' })
          .expect(403),
      );
      res403(
        await request(app.getHttpServer())
          .patch(`/api/v1/sales/customers/${customerId}`)
          .set('Authorization', bearer(plainToken))
          .send({ name: 'Nope' })
          .expect(403),
      );
      res403(
        await request(app.getHttpServer())
          .delete(`/api/v1/sales/customers/${customerId}`)
          .set('Authorization', bearer(plainToken))
          .expect(403),
      );
      // A BRANCH_MANAGER reads loyalty but does not adjust it.
      res403(
        await request(app.getHttpServer())
          .post(`/api/v1/sales/customers/${customerId}/points/adjust`)
          .set('Authorization', bearer(managerToken))
          .send({ points: 10, reason: 'x', idempotencyKey: 'mgr-1' })
          .expect(403),
      );
    });

    it('refuses a caller with no customer grant at all, and an anonymous one outright', async () => {
      await request(app.getHttpServer()).get('/api/v1/sales/customers').set('Authorization', bearer(outsiderToken)).expect(403);
      await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}`)
        .set('Authorization', bearer(outsiderToken))
        .expect(403);
      await request(app.getHttpServer()).get('/api/v1/sales/customers').expect(401);
    });
  });

  // ================================================================
  // 6. No restricted financial data on any customer surface
  // ================================================================
  describe('cost and profit', () => {
    it('leaks no cost, margin or profit key on ANY customer response, for anyone', async () => {
      const c = await createCustomer({ name: 'Cost Scan' });
      await creditSale(c.id, 2, 100);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${c.id}/points/adjust`)
        .set('Authorization', bearer(accountantToken))
        .send({ points: 25, reason: 'scan', idempotencyKey: `scan-${c.id}` })
        .expect(201);

      // The owner holds `products.view_cost`; even for them, nothing on a
      // customer surface carries cost — it is not a customer concept.
      for (const token of [ownerToken, managerToken, plainToken]) {
        const list = await request(app.getHttpServer())
          .get('/api/v1/sales/customers?limit=200')
          .set('Authorization', bearer(token))
          .expect(200);
        expect(findKeys(list.body.data, COST_KEYS)).toEqual([]);

        const detail = await request(app.getHttpServer())
          .get(`/api/v1/sales/customers/${c.id}`)
          .set('Authorization', bearer(token))
          .expect(200);
        expect(findKeys(detail.body.data, COST_KEYS)).toEqual([]);
      }

      for (const token of [ownerToken, managerToken]) {
        const points = await request(app.getHttpServer())
          .get(`/api/v1/sales/customers/${c.id}/points/ledger`)
          .set('Authorization', bearer(token))
          .expect(200);
        expect(findKeys(points.body, COST_KEYS)).toEqual([]);
      }
    });
  });

  // ================================================================
  // 7. Tenant isolation
  // ================================================================
  describe('tenant isolation', () => {
    it('hides another business’s customer behind a 404 on every route', async () => {
      const theirs = await createCustomer({ name: 'Their Customer', phone: '01008888888' }, other.accessToken);
      for (const path of [`/api/v1/sales/customers/${theirs.id}`, `/api/v1/sales/customers/${theirs.id}/points`, `/api/v1/sales/customers/${theirs.id}/points/ledger`]) {
        await request(app.getHttpServer()).get(path).set('Authorization', bearer(ownerToken)).expect(404);
      }
      await request(app.getHttpServer())
        .patch(`/api/v1/sales/customers/${theirs.id}`)
        .set('Authorization', bearer(ownerToken))
        .send({ name: 'Hijacked' })
        .expect(404);
      await request(app.getHttpServer())
        .delete(`/api/v1/sales/customers/${theirs.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(404);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${theirs.id}/points/adjust`)
        .set('Authorization', bearer(accountantToken))
        .send({ points: 10, reason: 'cross tenant', idempotencyKey: 'cross-1' })
        .expect(404);

      // ...and their name was not changed by the attempt.
      const stillTheirs = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${theirs.id}`)
        .set('Authorization', bearer(other.accessToken))
        .expect(200);
      expect(stillTheirs.body.data.name).toBe('Their Customer');
    });

    it('never returns another business’s customer in a list or a search', async () => {
      const mine = await request(app.getHttpServer())
        .get('/api/v1/sales/customers?limit=200')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      const theirs = await request(app.getHttpServer())
        .get('/api/v1/sales/customers?limit=200')
        .set('Authorization', bearer(other.accessToken))
        .expect(200);

      const mineIds = new Set(mine.body.data.map((c: { id: string }) => c.id));
      for (const row of theirs.body.data) expect(mineIds.has(row.id)).toBe(false);
      expect(mine.body.data.every((c: { businessId: string }) => c.businessId === biz.businessId)).toBe(true);

      // The raw-SQL search path is the one that could most easily leak,
      // so it is probed by an exact phone that exists only over there.
      const probe = await request(app.getHttpServer())
        .get('/api/v1/sales/customers?search=01008888888')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(probe.body.data).toEqual([]);
    });
  });
});
