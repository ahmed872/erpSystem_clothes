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

  /** Same as `stocked`, but hands back the product id too - needed when a
   *  promotion has to target the product rather than the variant. */
  async function stockedWithProduct() {
    const { productId, variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `EXP-${seq++}`, {
      defaultCost: 10,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 200, unitCost: 10 })
      .expect(201);
    return { productId, variantId };
  }

  /** A serial-tracked variant with `serials` received into stock. */
  async function serialVariant(serials: string[]) {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `EXS-${seq++}`, {
      tracksSerialNumbers: true,
      defaultCost: 10,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: serials.length, unitCost: 10, serials })
      .expect(201);
    return variantId;
  }

  const serialRow = (serial: string) =>
    admin.serialNumber.findFirstOrThrow({ where: { businessId: biz.businessId, serial } });

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
    it('refuses a refund that is not the amount the exchange permits, and leaves NOTHING behind', async () => {
      // BEHAVIOURAL CORRECTION, Phase 10.2. This test previously asserted
      // that a downward exchange was refused outright and told the caller
      // to record a return and a sale separately. The approved 10.2 policy
      // contradicts that directly: a downward exchange is now the same
      // atomic flow, refunding exactly the surplus.
      //
      // What the test guards has therefore moved, not weakened. It now
      // proves the REFUND IS NOT TRUSTED - a client-stated amount that is
      // not the one the two totals permit is refused - and it keeps the
      // atomicity assertion the old test carried, against the new rule.
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      // The surplus is 100 - 40 = 60. Asking for 30 keeps 30 of the
      // customer's money with no document saying where it went.
      const short = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 40 }],
        refund: { method: 'CASH', amount: 30 },
        payments: [],
      }).expect(422);
      expect(short.body.error.details.requiredRefund).toBe('60');
      expect(short.body.error.details.statedRefund).toBe('30');

      // Asking for MORE than the surplus is refused the same way.
      await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 40 }],
        refund: { method: 'CASH', amount: 90 },
        payments: [],
      }).expect(422);

      // Omitting the refund on a downward exchange is refused too - the
      // surplus would have nowhere to go.
      await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 40 }],
        payments: [],
      }).expect(422);

      // ATOMICITY: three refusals, nothing left behind. No return, no sale,
      // no stock movement, no journal entry, no money out of the drawer.
      // This is the assertion the whole one-transaction design exists for,
      // and it now covers the refund-validation path specifically.
      expect(await admin.saleReturn.count({ where: { saleId: sale.body.data.id } })).toBe(0);
      expect(await admin.sale.count({ where: { customerId, exchangeForReturn: { saleId: sale.body.data.id } } })).toBe(0);
      expect((await admin.stockBalance.findFirstOrThrow({ where: { variantId: oldItem } })).quantityOnHand.toString()).toBe('199');
      expect((await admin.stockBalance.findFirstOrThrow({ where: { variantId: newItem } })).quantityOnHand.toString()).toBe('200');
      expect(
        await admin.cashTransaction.count({ where: { businessId: biz.businessId, type: 'SALE_REFUND' } }),
      ).toBe(0);
    });

    it('refuses a refund on an UPWARD or EVEN exchange, where nothing is owed back', async () => {
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
        refund: { method: 'CASH', amount: 10 },
        payments: [{ amount: 50, method: 'CASH' }],
      }).expect(422);
      expect(res.body.error.details.requiredRefund).toBe('0');
      expect(JSON.stringify(res.body)).toMatch(/tenders the difference/i);
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
  // Phase 10.2 — DOWNWARD EXCHANGES.
  //
  // The same atomic flow, with two figures taking different values:
  //
  //     requiredRefund = max(0, returnCredit - replacementTotal)
  //     creditApplied  = returnCredit - requiredRefund
  //
  // so the two settlement identities hold in every direction:
  //
  //     returnCredit     = creditApplied + refund
  //     replacementTotal = creditApplied + tender
  // ==================================================================
  describe('Downward exchanges', () => {
    it('100 for 80: the credit settles the replacement and 20 goes back as money', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const clearingBefore = await clearingBalance();

      const res = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 80 }],
        refund: { method: 'CASH', amount: 20 },
        payments: [],
      }).expect(201);

      // The three figures a receipt shows. Exactly one of the last two is
      // non-zero, in every direction.
      expect(res.body.data.exchangeCredit).toBe('80');
      expect(res.body.data.amountDue).toBe('0');
      expect(res.body.data.refunded).toBe('20');

      // THE REFUND IS A REAL TENDER, recorded where a return records one.
      const saleReturn = await admin.saleReturn.findUniqueOrThrow({ where: { id: res.body.data.saleReturn.id } });
      expect(saleReturn.refundMethod).toBe('CASH');
      expect(saleReturn.refundAmount!.toString()).toBe('20');

      // ...and 20 of physical money left the drawer, in the same
      // transaction, exactly as a plain cash refund does.
      const drawer = await admin.cashTransaction.findFirstOrThrow({
        where: { businessId: biz.businessId, referenceType: 'SaleReturn', referenceId: saleReturn.id },
      });
      expect(drawer.type).toBe('SALE_REFUND');
      expect(drawer.amount.toString()).toBe('-20');

      // The replacement consumed ONLY the credit - no cash came in.
      const replacement = await admin.sale.findUniqueOrThrow({
        where: { id: res.body.data.sale.id },
        include: { payments: true },
      });
      expect(replacement.totalAmount.toString()).toBe('80');
      expect(replacement.payments.map((p) => `${p.method}:${p.amount}`)).toEqual(['EXCHANGE_CREDIT:80']);
      expect(replacement.exchangeForReturnId).toBe(saleReturn.id);

      // ACCOUNTING. C + P = N + R  =>  100 + 0 = 80 + 20.
      const returnEntry = await entryFor('SaleReturn', saleReturn.id);
      expect(netDebitOnCode(returnEntry, '4100').toString()).toBe('100'); // revenue reversed in full
      expect(netDebitOnCode(returnEntry, '1070').toString()).toBe('-80'); // clearing credited
      expect(netDebitOnCode(returnEntry, '1010').toString()).toBe('-20'); // cash credited
      // Nothing was parked on the customer's ledger: every unit of the
      // credit was either spent or handed back.
      expect(netDebitOnCode(returnEntry, '1100').toString()).toBe('0');

      const saleEntry = await entryFor('Sale', res.body.data.sale.id);
      expect(netDebitOnCode(saleEntry, '1070').toString()).toBe('80'); // clearing debited
      expect(netDebitOnCode(saleEntry, '4100').toString()).toBe('-80');

      // Both entries balance in their own right...
      for (const entry of [returnEntry, saleEntry]) {
        const debit = entry.lines.reduce((sum, l) => sum.plus(l.debit), D(0));
        const credit = entry.lines.reduce((sum, l) => sum.plus(l.credit), D(0));
        expect(debit.toString()).toBe(credit.toString());
      }
      // ...and the clearing account is exactly where it started.
      expect((await clearingBalance()).toString()).toBe(clearingBefore.toString());

      // The customer is square: they paid 100, hold 80 of goods and 20 of
      // cash, and owe nothing.
      const ledger = await admin.customerTransaction.findMany({ where: { customerId } });
      const balance = ledger.reduce((sum, t) => sum.plus(t.amount), D(0));
      expect(balance.toString()).toBe('0');
    });

    it('a WALK-IN can exchange downward: the surplus goes back as cash, nothing is stranded', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 60 }],
        payments: [{ amount: 60 }],
      }).expect(201);

      const res = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 45 }],
        refund: { method: 'CASH', amount: 15 },
        payments: [],
      }).expect(201);

      expect(res.body.data.refunded).toBe('15');
      expect(res.body.data.exchangeCredit).toBe('45');

      // A walk-in has no ledger for a remainder to sit on. The exchange
      // settles the whole credit by construction - 45 onto the replacement
      // and 15 back as money - so nothing vanishes.
      const entry = await entryFor('SaleReturn', res.body.data.saleReturn.id);
      expect(netDebitOnCode(entry, '1100').toString()).toBe('0'); // no AR for a walk-in
      expect(netDebitOnCode(entry, '1070').toString()).toBe('-45');
      expect(netDebitOnCode(entry, '1010').toString()).toBe('-15');
    });

    it('an EVEN exchange refunds nothing and tenders nothing', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 70 }],
        payments: [{ amount: 70 }],
      }).expect(201);

      const before = await clearingBalance();
      const res = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 70 }],
        payments: [],
      }).expect(201);

      expect(res.body.data.exchangeCredit).toBe('70');
      expect(res.body.data.amountDue).toBe('0');
      expect(res.body.data.refunded).toBe('0');
      expect((await admin.saleReturn.findUniqueOrThrow({ where: { id: res.body.data.saleReturn.id } })).refundAmount).toBeNull();
      expect(await admin.cashTransaction.count({ where: { referenceId: res.body.data.saleReturn.id } })).toBe(0);
      expect((await clearingBalance()).toString()).toBe(before.toString());
    });

    it('moves the stock both ways and takes it back through the Inventory Engine', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 4, unitPrice: 50 }],
        payments: [{ amount: 200 }],
      }).expect(201);

      const res = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 4, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 3, unitPrice: 40 }],
        refund: { method: 'CASH', amount: 80 },
        payments: [],
      }).expect(201);
      expect(res.body.data.refunded).toBe('80'); // 200 - 120

      const back = await admin.stockMovement.findFirstOrThrow({
        where: { variantId: oldItem, movementType: 'SALES_RETURN', referenceId: res.body.data.saleReturn.id },
      });
      expect(back.quantityBase.toString()).toBe('4');
      const out = await admin.stockMovement.findFirstOrThrow({
        where: { variantId: newItem, movementType: 'SALE', referenceId: res.body.data.sale.id },
      });
      expect(out.quantityBase.toString()).toBe('-3');

      expect((await admin.stockBalance.findFirstOrThrow({ where: { variantId: oldItem } })).quantityOnHand.toString()).toBe('200');
      expect((await admin.stockBalance.findFirstOrThrow({ where: { variantId: newItem } })).quantityOnHand.toString()).toBe('197');
    });

    it('carries TAX on both legs: the refund covers the tax the customer paid on what came back', async () => {
      const taxId = await createTax(app, biz.accessToken, 10);
      const oldItem = await stocked({ taxId });
      const newItem = await stocked({ taxId });
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 110 }],
      }).expect(201);

      // C = 100 + 10 tax = 110.  N = 80 + 8 tax = 88.  R = 22.
      const res = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 80 }],
        refund: { method: 'CASH', amount: 22 },
        payments: [],
      }).expect(201);
      expect(res.body.data.exchangeCredit).toBe('88');
      expect(res.body.data.refunded).toBe('22');

      const returnEntry = await entryFor('SaleReturn', res.body.data.saleReturn.id);
      expect(netDebitOnCode(returnEntry, '2200').toString()).toBe('10'); // liability reduced by what came back
      const saleEntry = await entryFor('Sale', res.body.data.sale.id);
      expect(netDebitOnCode(saleEntry, '2200').toString()).toBe('-8'); // and raised by what went out
    });

    it('a PROMOTION on the replacement is what makes the exchange downward, and the refund follows it', async () => {
      const oldItem = await stocked();
      const { variantId: newItem, productId } = await stockedWithProduct();
      await request(app.getHttpServer())
        .post('/api/v1/promotions')
        .set('Authorization', auth())
        .send({
          name: `Exchange promo ${seq++}`,
          type: 'PERCENTAGE',
          percentageValue: 20,
          targetType: 'PRODUCT',
          targetId: productId,
          validFrom: '2020-01-01',
          validTo: '2099-12-31',
        })
        .expect(201);

      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      // The replacement lists at 100 and resolves to 80 server-side, so the
      // exchange is downward by 20 - a figure the client could only know by
      // asking the server, which is why a wrong guess is refused.
      const res = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
        refund: { method: 'CASH', amount: 20 },
        payments: [],
      }).expect(201);

      const replacement = await admin.sale.findUniqueOrThrow({ where: { id: res.body.data.sale.id } });
      expect(replacement.discountAmount.toString()).toBe('20');
      expect(replacement.totalAmount.toString()).toBe('80');
      expect(res.body.data.refunded).toBe('20');
    });

    it('claws back the points on what came back and earns on what went out', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.points_per_currency_unit', value: 1 })
        .expect(200);

      const loyal = (
        await request(app.getHttpServer())
          .post('/api/v1/sales/customers')
          .set('Authorization', auth())
          .send({ name: `Loyal exchanger ${seq++}` })
          .expect(201)
      ).body.data.id as string;

      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId: loyal,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const balanceOf = async () =>
        (await admin.customerPoints.findMany({ where: { customerId: loyal } })).reduce((sum, p) => sum.plus(p.points), D(0));
      expect((await balanceOf()).toString()).toBe('100');

      await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 80 }],
        refund: { method: 'CASH', amount: 20 },
        payments: [],
      }).expect(201);

      // 100 earned, 100 clawed back on the return, 80 earned on the
      // replacement. Both halves apply their own approved rule and the
      // arithmetic is simply their sum.
      expect((await balanceOf()).toString()).toBe('80');
      const events = await admin.customerPoints.findMany({ where: { customerId: loyal }, orderBy: { createdAt: 'asc' } });
      expect(events.map((e) => e.type)).toEqual(['EARN', 'RETURN_CLAWBACK', 'EARN']);
      // The ledger is append-only: nothing was rewritten, only added to.
      expect(events.every((e) => !e.points.isZero())).toBe(true);

      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.points_per_currency_unit', value: null })
        .expect(200);
    });

    it('preserves the serial lifecycle on both legs', async () => {
      const oldItem = await serialVariant(['EX-OLD-1']);
      const newItem = await serialVariant(['EX-NEW-1']);
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100, serials: ['EX-OLD-1'] }],
        payments: [{ amount: 100 }],
      }).expect(201);
      expect((await serialRow('EX-OLD-1')).status).toBe('SOLD');

      const res = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE', serials: ['EX-OLD-1'] }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 80, serials: ['EX-NEW-1'] }],
        refund: { method: 'CASH', amount: 20 },
        payments: [],
      }).expect(201);

      // BD-22 on the way in, BD-13 on the way out - both unchanged.
      const returned = await serialRow('EX-OLD-1');
      expect(returned.status).toBe('IN_STOCK');
      expect(returned.currentWarehouseId).toBe(biz.warehouseId);
      expect((await serialRow('EX-NEW-1')).status).toBe('SOLD');

      // And the historical links survive on both sides.
      expect(await admin.saleReturnItemSerial.count({ where: { saleReturnId: res.body.data.saleReturn.id } })).toBe(1);
      expect(await admin.saleItemSerial.count({ where: { saleId: res.body.data.sale.id } })).toBe(1);
    });

    it('replays one key to the SAME pair and refunds the money exactly once', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const body = {
        idempotencyKey: `downward-replay-${seq++}`,
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 80 }],
        refund: { method: 'CASH', amount: 20 },
        payments: [],
      };

      const first = await exchange(sale.body.data.id, body).expect(201);
      const second = await exchange(sale.body.data.id, body).expect(201);

      expect(second.body.data.sale.id).toBe(first.body.data.sale.id);
      expect(second.body.data.saleReturn.id).toBe(first.body.data.saleReturn.id);
      expect(second.body.data.refunded).toBe('20');
      expect(second.body.data.exchangeCredit).toBe('80');

      // THE ASSERTION THAT MATTERS: the money left the drawer once.
      expect(
        await admin.cashTransaction.count({
          where: { businessId: biz.businessId, referenceType: 'SaleReturn', referenceId: first.body.data.saleReturn.id },
        }),
      ).toBe(1);
      expect(await admin.saleReturn.count({ where: { saleId: sale.body.data.id } })).toBe(1);
      expect(await admin.sale.count({ where: { exchangeForReturnId: first.body.data.saleReturn.id } })).toBe(1);
      expect(
        await admin.stockMovement.count({ where: { variantId: newItem, referenceId: first.body.data.sale.id } }),
      ).toBe(1);
    });

    it('rejects the same key carrying a DIFFERENT refund tender', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const base = {
        idempotencyKey: `downward-differs-${seq++}`,
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 80 }],
        payments: [],
      };
      await exchange(sale.body.data.id, { ...base, refund: { method: 'CASH', amount: 20 } }).expect(201);

      // Same money, different door. Cash out of a drawer and a card refund
      // are not the same event, so a replay claiming the other is refused.
      await exchange(sale.body.data.id, { ...base, refund: { method: 'CARD', amount: 20 } }).expect(409);

      expect(
        await admin.cashTransaction.count({ where: { businessId: biz.businessId, referenceType: 'SaleReturn' } }),
      ).toBeGreaterThan(0);
      expect(await admin.saleReturn.count({ where: { saleId: sale.body.data.id } })).toBe(1);
    });

    it('two concurrent identical exchanges settle as ONE', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const body = {
        idempotencyKey: `downward-race-${seq++}`,
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 80 }],
        refund: { method: 'CASH', amount: 20 },
        payments: [],
      };

      const results = await Promise.all([exchange(sale.body.data.id, body), exchange(sale.body.data.id, body)]);
      expect(results.some((r) => r.status === 201)).toBe(true);

      // Whatever the two requests each saw, the world holds exactly one
      // exchange: one return, one replacement, one refund, goods moved once.
      const returns = await admin.saleReturn.findMany({ where: { saleId: sale.body.data.id } });
      expect(returns.length).toBe(1);
      expect(await admin.sale.count({ where: { exchangeForReturnId: returns[0].id } })).toBe(1);
      expect(
        await admin.cashTransaction.count({ where: { referenceType: 'SaleReturn', referenceId: returns[0].id } }),
      ).toBe(1);
      expect((await admin.stockBalance.findFirstOrThrow({ where: { variantId: newItem } })).quantityOnHand.toString()).toBe('199');
    });

    it('is untouched by a later rate change - both documents keep the figures they were written with', async () => {
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
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 80 }],
        refund: { method: 'CASH', amount: 22 },
        payments: [],
      }).expect(201);

      await request(app.getHttpServer())
        .patch(`/api/v1/taxes/${taxId}`)
        .set('Authorization', auth())
        .send({ ratePercent: 25 })
        .expect(200);

      // Re-read AFTER the world changed. Non-negotiable #8.
      const storedReturn = await admin.saleReturn.findUniqueOrThrow({ where: { id: res.body.data.saleReturn.id } });
      expect(storedReturn.refundAmount!.toString()).toBe('22');
      const storedSale = await admin.sale.findUniqueOrThrow({ where: { id: res.body.data.sale.id } });
      expect(storedSale.taxAmount.toString()).toBe('8');
      expect(storedSale.totalAmount.toString()).toBe('88');
      const entry = await entryFor('SaleReturn', storedReturn.id);
      expect(netDebitOnCode(entry, '1010').toString()).toBe('-22');
    });

    it('rolls the WHOLE downward exchange back when the replacement is out of stock', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const refundsBefore = await admin.cashTransaction.count({
        where: { businessId: biz.businessId, type: 'SALE_REFUND' },
      });

      await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 5000, unitPrice: 0.01 }],
        refund: { method: 'CASH', amount: 50 },
        payments: [],
      }).expect(409);

      // The goods did not come back, and - the point of this test - the
      // money did not leave the drawer either. A refund written by a half
      // that succeeded on its own would be real money gone with no goods
      // exchanged for it.
      expect(await admin.saleReturn.count({ where: { saleId: sale.body.data.id } })).toBe(0);
      expect((await admin.stockBalance.findFirstOrThrow({ where: { variantId: oldItem } })).quantityOnHand.toString()).toBe('199');
      expect(
        await admin.cashTransaction.count({ where: { businessId: biz.businessId, type: 'SALE_REFUND' } }),
      ).toBe(refundsBefore);
    });

    it('cannot exchange against another tenant\'s sale', async () => {
      const other = await setupSalesFixture(app, `exother${seq++}`);
      const { variantId } = await createSimpleProduct(app, other.accessToken, other.uomId, `OTH-${seq++}`, { defaultCost: 1 });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ warehouseId: other.warehouseId, variantId, quantity: 10, unitCost: 1 })
        .expect(201);
      const theirSale = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ warehouseId: other.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 100 }] })
        .expect(201);

      // Their sale is invisible here, not merely forbidden.
      await exchange(theirSale.body.data.id, {
        returnItems: [{ saleItemId: theirSale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: await stocked(), quantity: 1, unitPrice: 80 }],
        refund: { method: 'CASH', amount: 20 },
        payments: [],
      }).expect(404);

      expect(await admin.saleReturn.count({ where: { saleId: theirSale.body.data.id } })).toBe(0);
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
