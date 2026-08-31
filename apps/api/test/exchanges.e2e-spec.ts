import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture, createTax } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 10 (Exchanges) — goods back and goods out, as ONE event.
 *
 * The claims under test:
 *
 *   1. IT IS ATOMIC. An exchange that half-succeeded - goods back on the
 *      shelf, replacement never issued, customer already out of the door -
 *      is a failure no reconciliation could untangle. Nothing must be able
 *      to leave one half standing.
 *   2. IT REUSES, NEVER REIMPLEMENTS. The two halves are the same return
 *      and the same sale the ordinary endpoints create. BD-1 still decides
 *      the credit, BD-18 still decides the tax, BD-13 still demands
 *      serials, and the engines remain the only things that move stock or
 *      post entries.
 *   3. THE CLEARING ACCOUNT NETS TO ZERO. The return credits it, the
 *      replacement debits it, and a completed exchange leaves it at
 *      exactly zero - which is what makes a non-zero balance a real signal.
 *   4. A CLIENT CANNOT MINT EXCHANGE CREDIT. Only the server produces the
 *      EXCHANGE_CREDIT tender; a request that names it is refused.
 */
describe('Exchanges (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let customerId: string;
  let seq = 0;

  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'exchange');
    customerId = (
      await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', auth())
        .send({ name: 'Exchange Customer' })
        .expect(201)
    ).body.data.id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function stocked(opts: { taxId?: string } = {}) {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `EX-${seq++}`, {
      defaultCost: 10,
      ...opts,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 200, unitCost: 10 })
      .expect(201);
    return variantId;
  }

  function sell(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, ...body });
  }

  const exchange = (saleId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`/api/v1/sales/${saleId}/exchanges`).set('Authorization', auth()).send(body);

  async function entryFor(sourceType: string, sourceId: string) {
    return admin.journalEntry.findFirstOrThrow({
      where: { sourceType, sourceId },
      include: { lines: { include: { account: true } } },
    });
  }
  function netDebitOnCode(
    entry: { lines: { account: { code: string }; debit: Prisma.Decimal; credit: Prisma.Decimal }[] },
    code: string,
  ) {
    return entry.lines
      .filter((l) => l.account.code === code)
      .reduce((sum, l) => sum.plus(l.debit).minus(l.credit), D(0));
  }

  /** The tenant-wide balance of the exchange clearing account (1070). */
  async function clearingBalance() {
    const account = await admin.account.findFirstOrThrow({ where: { businessId: biz.businessId, code: '1070' } });
    const agg = await admin.journalEntryLine.aggregate({
      where: { accountId: account.id },
      _sum: { debit: true, credit: true },
    });
    return D(agg._sum.debit ?? 0).minus(agg._sum.credit ?? 0);
  }

  // ==================================================================
  it('swaps one item for a dearer one: the credit settles part of it, the customer tenders the rest', async () => {
    const oldItem = await stocked();
    const newItem = await stocked();

    const sale = await sell({
      customerId,
      items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
      payments: [{ amount: 100 }],
    }).expect(201);

    const res = await exchange(sale.body.data.id, {
      returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
      newItems: [{ variantId: newItem, quantity: 1, unitPrice: 150 }],
      payments: [{ amount: 50, method: 'CASH' }],
    }).expect(201);

    expect(res.body.data.exchangeCredit).toBe('100');
    expect(res.body.data.amountDue).toBe('50');

    const replacement = await admin.sale.findUniqueOrThrow({
      where: { id: res.body.data.sale.id },
      include: { payments: true },
    });
    expect(replacement.totalAmount.toString()).toBe('150');
    // The link points from the sale to the return, because the return is
    // created first - its credit is what the replacement is settled with.
    expect(replacement.exchangeForReturnId).toBe(res.body.data.saleReturn.id);

    const byMethod = Object.fromEntries(replacement.payments.map((p) => [p.method, p.amount.toString()]));
    expect(byMethod).toEqual({ EXCHANGE_CREDIT: '100', CASH: '50' });

    // Only the 50 of REAL money reached the drawer. The exchange credit is
    // not a tender and must never inflate expected cash.
    const drawer = await admin.cashTransaction.findMany({
      where: { businessId: biz.businessId, referenceId: replacement.id },
    });
    expect(drawer.map((d) => `${d.type}:${d.amount}`)).toEqual(['SALE_TENDER:50']);
  });

  it('nets the clearing account to EXACTLY zero across the pair', async () => {
    const before = await clearingBalance();

    const oldItem = await stocked();
    const newItem = await stocked();
    const sale = await sell({
      customerId,
      items: [{ variantId: oldItem, quantity: 2, unitPrice: 60 }],
      payments: [{ amount: 120 }],
    }).expect(201);

    const res = await exchange(sale.body.data.id, {
      returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 2, condition: 'SELLABLE' }],
      newItems: [{ variantId: newItem, quantity: 1, unitPrice: 200 }],
      payments: [{ amount: 80, method: 'CARD' }],
    }).expect(201);

    const returnEntry = await entryFor('SaleReturn', res.body.data.saleReturn.id);
    const saleEntry = await entryFor('Sale', res.body.data.sale.id);

    // The return CREDITS clearing by the whole credit...
    expect(netDebitOnCode(returnEntry, '1070').toString()).toBe('-120');
    // ...and the replacement DEBITS it by the same figure.
    expect(netDebitOnCode(saleEntry, '1070').toString()).toBe('120');

    expect((await clearingBalance()).toString()).toBe(before.toString());

    // Both entries balance in their own right, as every entry must.
    for (const entry of [returnEntry, saleEntry]) {
      const debit = entry.lines.reduce((s, l) => s.plus(l.debit), D(0));
      const credit = entry.lines.reduce((s, l) => s.plus(l.credit), D(0));
      expect(debit.toString()).toBe(credit.toString());
    }
  });

  it('leaves NOTHING on the customer ledger for the credit itself - it was spent on the replacement', async () => {
    const oldItem = await stocked();
    const newItem = await stocked();
    const sale = await sell({
      customerId,
      items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
      payments: [{ amount: 100 }],
    }).expect(201);

    const res = await exchange(sale.body.data.id, {
      returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
      newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
      payments: [],
    }).expect(201);

    // No SALE_RETURN credit row: posting one as well would credit the
    // customer twice for one set of goods.
    const returnCredit = await admin.customerTransaction.findFirst({
      where: { referenceType: 'SaleReturn', referenceId: res.body.data.saleReturn.id },
    });
    expect(returnCredit).toBeNull();

    // The replacement's SALE debit and its EXCHANGE_CREDIT payment cancel,
    // so an even swap leaves the account exactly where it started.
    const rows = await admin.customerTransaction.findMany({
      where: { referenceType: 'Sale', referenceId: res.body.data.sale.id },
    });
    expect(rows.reduce((s, r) => s.plus(r.amount), D(0)).toString()).toBe('0');
  });

  it('a WALK-IN can exchange: the credit settles the replacement, so nothing is stranded', async () => {
    const oldItem = await stocked();
    const newItem = await stocked();
    // A walk-in return normally MUST be refunded in full, because there is
    // no ledger for a remainder. An exchange satisfies that by
    // construction - the credit is spent, not left hanging.
    const sale = await sell({
      items: [{ variantId: oldItem, quantity: 1, unitPrice: 80 }],
      payments: [{ amount: 80 }],
    }).expect(201);

    const res = await exchange(sale.body.data.id, {
      returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
      newItems: [{ variantId: newItem, quantity: 1, unitPrice: 95 }],
      payments: [{ amount: 15, method: 'CASH' }],
    }).expect(201);

    expect(res.body.data.exchangeCredit).toBe('80');
    expect(res.body.data.amountDue).toBe('15');
    expect((await admin.saleReturn.findUniqueOrThrow({ where: { id: res.body.data.saleReturn.id } })).refundAmount).toBeNull();
  });

  it('carries TAX through both halves - BD-18 is not reinterpreted here', async () => {
    const taxId = await createTax(app, biz.accessToken, 10);
    const oldItem = await stocked({ taxId });
    const newItem = await stocked({ taxId });

    const sale = await sell({
      customerId,
      items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
      payments: [{ amount: 110 }],
    }).expect(201);

    const res = await exchange(sale.body.data.id, {
      returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
      newItems: [{ variantId: newItem, quantity: 1, unitPrice: 200 }],
      payments: [{ amount: 110, method: 'CASH' }],
    }).expect(201);

    // The credit is the merchandise 100 PLUS the 10 of tax the customer
    // paid on it - exactly what a stand-alone return would give back.
    expect(res.body.data.exchangeCredit).toBe('110');
    // The replacement is 200 + 20 tax = 220, of which 110 is credit.
    expect(res.body.data.amountDue).toBe('110');

    const returnEntry = await entryFor('SaleReturn', res.body.data.saleReturn.id);
    expect(netDebitOnCode(returnEntry, '2200').toString()).toBe('10'); // tax liability reduced
    const saleEntry = await entryFor('Sale', res.body.data.sale.id);
    expect(netDebitOnCode(saleEntry, '2200').toString()).toBe('-20'); // tax liability raised
  });

  it('moves the stock BOTH ways through the Inventory Engine, in one transaction', async () => {
    const oldItem = await stocked();
    const newItem = await stocked();
    const sale = await sell({
      customerId,
      items: [{ variantId: oldItem, quantity: 3, unitPrice: 50 }],
      payments: [{ amount: 150 }],
    }).expect(201);

    const res = await exchange(sale.body.data.id, {
      returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 3, condition: 'SELLABLE' }],
      newItems: [{ variantId: newItem, quantity: 2, unitPrice: 90 }],
      payments: [{ amount: 30, method: 'CASH' }],
    }).expect(201);

    const back = await admin.stockMovement.findFirstOrThrow({
      where: { variantId: oldItem, movementType: 'SALES_RETURN', referenceId: res.body.data.saleReturn.id },
    });
    expect(back.quantityBase.toString()).toBe('3');
    const out = await admin.stockMovement.findFirstOrThrow({
      where: { variantId: newItem, movementType: 'SALE', referenceId: res.body.data.sale.id },
    });
    expect(out.quantityBase.toString()).toBe('-2');

    // 200 opening - 3 sold + 3 back = 200; 200 opening - 2 out = 198.
    expect((await admin.stockBalance.findFirstOrThrow({ where: { variantId: oldItem } })).quantityOnHand.toString()).toBe('200');
    expect((await admin.stockBalance.findFirstOrThrow({ where: { variantId: newItem } })).quantityOnHand.toString()).toBe('198');
  });

  // ==================================================================
  describe('Refusals', () => {
    it('refuses a DOWNWARD exchange, naming both figures and what to do instead', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const res = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 40 }],
        payments: [],
      }).expect(422);
      expect(JSON.stringify(res.body)).toMatch(/separately/i);

      // ATOMICITY: the refusal left NOTHING behind. No return, no sale, no
      // stock movement, no journal entry. This is the assertion the whole
      // one-transaction design exists for.
      expect(await admin.saleReturn.count({ where: { saleId: sale.body.data.id } })).toBe(0);
      expect(await admin.sale.count({ where: { customerId, exchangeForReturn: { saleId: sale.body.data.id } } })).toBe(0);
      expect((await admin.stockBalance.findFirstOrThrow({ where: { variantId: oldItem } })).quantityOnHand.toString()).toBe('199');
    });

    it('rolls the WHOLE exchange back when the replacement is out of stock', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      // 200 in stock, 5000 requested.
      await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 5000, unitPrice: 1 }],
        payments: [{ amount: 4900, method: 'CASH' }],
      }).expect(409);

      // The goods did NOT come back: the half that would have succeeded on
      // its own was rolled back with the half that failed.
      expect(await admin.saleReturn.count({ where: { saleId: sale.body.data.id } })).toBe(0);
      expect((await admin.stockBalance.findFirstOrThrow({ where: { variantId: oldItem } })).quantityOnHand.toString()).toBe('199');
    });

    it('a client cannot name EXCHANGE_CREDIT as a tender - not on an exchange, a sale, or a payment', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      // On the exchange's own top-up payments.
      await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 150 }],
        payments: [{ amount: 50, method: 'EXCHANGE_CREDIT' }],
      }).expect(422);

      // On an ordinary sale - the obvious way to pay for goods with nothing.
      await sell({
        customerId,
        items: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100, method: 'EXCHANGE_CREDIT' }],
      }).expect(422);

      // On a later payment against an open sale.
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.body.data.id}/payments`)
        .set('Authorization', auth())
        .send({ amount: 10, method: 'EXCHANGE_CREDIT' })
        .expect(422);

      // And on a stand-alone return's refund.
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.body.data.id}/returns`)
        .set('Authorization', auth())
        .send({
          items: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          refund: { method: 'EXCHANGE_CREDIT', amount: 100 },
        })
        .expect(422);
    });

    it('refuses to exchange against a sale that does not exist', async () => {
      await exchange('00000000-0000-0000-0000-000000000000', {
        returnItems: [{ saleItemId: '00000000-0000-0000-0000-000000000001', quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: await stocked(), quantity: 1, unitPrice: 10 }],
        payments: [{ amount: 10, method: 'CASH' }],
      }).expect(404);
    });
  });

  // ==================================================================
  describe('Idempotency', () => {
    it('replays the whole PAIR from one key, and reads the credit from what was stored', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const body = {
        idempotencyKey: 'exchange-replay-1',
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 150 }],
        payments: [{ amount: 50, method: 'CASH' }],
      };

      const first = await exchange(sale.body.data.id, body).expect(201);
      const second = await exchange(sale.body.data.id, body).expect(201);

      expect(second.body.data.sale.id).toBe(first.body.data.sale.id);
      expect(second.body.data.saleReturn.id).toBe(first.body.data.saleReturn.id);
      expect(second.body.data.exchangeCredit).toBe('100');
      expect(second.body.data.amountDue).toBe('50');

      // Exactly ONE of each document, and the goods moved exactly once.
      expect(await admin.saleReturn.count({ where: { saleId: sale.body.data.id } })).toBe(1);
      expect(await admin.sale.count({ where: { exchangeForReturnId: first.body.data.saleReturn.id } })).toBe(1);
      expect(
        await admin.stockMovement.count({ where: { variantId: newItem, referenceId: first.body.data.sale.id } }),
      ).toBe(1);
    });

    it('rejects the same key carrying a MATERIALLY different exchange', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 2, unitPrice: 100 }],
        payments: [{ amount: 200 }],
      }).expect(201);

      const base = {
        idempotencyKey: 'exchange-replay-2',
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 150 }],
        payments: [{ amount: 50, method: 'CASH' }],
      };
      await exchange(sale.body.data.id, base).expect(201);

      // A different replacement under the same key must not be silently
      // handed the first exchange's documents.
      await exchange(sale.body.data.id, {
        ...base,
        newItems: [{ variantId: newItem, quantity: 2, unitPrice: 150 }],
        payments: [{ amount: 200, method: 'CASH' }],
      }).expect(409);
    });
  });

  // ==================================================================
  describe('Authorization', () => {
    it('requires BOTH sales.return and sales.create - a cashier who can only sell cannot exchange', async () => {
      // A bespoke role that can SELL but not take goods back. No stock
      // role happens to have that exact shape, and asserting against
      // whichever one currently does would make this test hostage to an
      // unrelated change in the seed.
      const role = await request(app.getHttpServer())
        .post('/api/v1/roles')
        .set('Authorization', auth())
        .send({
          name: 'Sell Only',
          permissionCodes: ['sales.create', 'sales.view', 'shifts.open', 'shifts.view', 'products.view', 'inventory.view', 'customers.view'],
        })
        .expect(201);
      const roleId = role.body.data.id as string;

      const email = `exchanger@${biz.slug}.test`;
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'exchanger', email, password: 'RoleUserPass1!', roleIds: [roleId], branchIds: [] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'RoleUserPass1!', businessSlug: biz.slug })
        .expect(200);

      const oldItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.body.data.id}/exchanges`)
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .send({
          returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          newItems: [{ variantId: await stocked(), quantity: 1, unitPrice: 150 }],
          payments: [{ amount: 50, method: 'CASH' }],
        })
        .expect(403);
    });
  });
});
