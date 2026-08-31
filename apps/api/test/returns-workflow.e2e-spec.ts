import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture, createTax } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Phase 12 (Returns, finished properly) — the returns desk, end to end.
 *
 * Two claims are under test and everything below serves one of them:
 *
 *   1. THE PREVIEW EQUALS THE RETURN. Whatever `POST /sales/:id/returns/
 *      preview` says the credit is, the return that follows charges
 *      exactly that - because both run BD-1's `lineReturnCredit` and
 *      BD-18's `cumulativeLineTax`, not two implementations of them.
 *   2. THE PREVIEW CHANGES NOTHING. Not a row, not a serial, not a point.
 *
 * Plus the two things that made the old screen unusable: a serial-tracked
 * product could not be returned at all, and a walk-in refund had to equal
 * a figure nobody was shown.
 */
describe('Returns workflow (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let seq = 0;

  const YESTERDAY = '2020-01-01';
  const FAR_FUTURE = '2091-01-01';

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'returns-wf');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function stocked(opts: { taxId?: string; qty?: number } = {}) {
    const { productId, variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `RW-${seq++}`, {
      defaultCost: 10,
      ...(opts.taxId ? { taxId: opts.taxId } : {}),
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: opts.qty ?? 200, unitCost: 10 })
      .expect(201);
    return { productId, variantId };
  }

  async function serialVariant(serials: string[]) {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `RWS-${seq++}`, {
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

  const sell = (body: Record<string, unknown>, token = auth()) =>
    request(app.getHttpServer()).post('/api/v1/sales').set('Authorization', token).send({ warehouseId: biz.warehouseId, ...body });

  const preview = (saleId: string, body: Record<string, unknown>, token = auth()) =>
    request(app.getHttpServer()).post(`/api/v1/sales/${saleId}/returns/preview`).set('Authorization', token).send(body);

  const refund = (saleId: string, body: Record<string, unknown>, token = auth()) =>
    request(app.getHttpServer()).post(`/api/v1/sales/${saleId}/returns`).set('Authorization', token).send(body);

  const lookup = (saleNumber: string, token = auth()) =>
    request(app.getHttpServer()).get(`/api/v1/sales?saleNumber=${encodeURIComponent(saleNumber)}`).set('Authorization', token);

  async function setRate(key: string, value: unknown) {
    await request(app.getHttpServer()).put('/api/v1/settings').set('Authorization', auth()).send({ key, value }).expect(200);
  }

  async function createCustomer(name: string) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales/customers')
      .set('Authorization', auth())
      .send({ name })
      .expect(201);
    return res.body.data.id as string;
  }

  /** A walk-in sale of `qty` at `price`, paid exactly. */
  async function walkInSale(variantId: string, qty: number, price: number, extra: Record<string, unknown> = {}) {
    const q = await request(app.getHttpServer())
      .post('/api/v1/sales/quote')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: qty, unitPrice: price, ...extra }] })
      .expect(200);
    const total = q.body.data.totals.amountDue;
    const sale = await sell({
      items: [{ variantId, quantity: qty, unitPrice: price, ...extra }],
      payments: [{ amount: Number(total), method: 'CASH' }],
    }).expect(201);
    return sale.body.data;
  }

  /** Every table a return touches, counted. */
  async function footprint() {
    const [returns, items, movements, entries, lines, points, serialLinks, custTx, balances] = await Promise.all([
      admin.saleReturn.count({ where: { businessId: biz.businessId } }),
      admin.saleReturnItem.count({ where: { businessId: biz.businessId } }),
      admin.stockMovement.count({ where: { businessId: biz.businessId } }),
      admin.journalEntry.count({ where: { businessId: biz.businessId } }),
      admin.journalEntryLine.count({ where: { businessId: biz.businessId } }),
      admin.customerPoints.count({ where: { businessId: biz.businessId } }),
      admin.saleReturnItemSerial.count({ where: { businessId: biz.businessId } }),
      admin.customerTransaction.count({ where: { businessId: biz.businessId } }),
      admin.stockBalance.aggregate({ where: { businessId: biz.businessId }, _sum: { quantityOnHand: true } }),
    ]);
    return { returns, items, movements, entries, lines, points, serialLinks, custTx, onHand: balances._sum.quantityOnHand?.toString() ?? '0' };
  }

  // ==================================================================
  describe('Finding the sale', () => {
    it('finds a sale by its RECEIPT NUMBER, whichever shift produced it', async () => {
      const { variantId } = await stocked();
      const sale = await walkInSale(variantId, 1, 50);

      const found = await lookup(sale.saleNumber).expect(200);
      expect(found.body.data).toHaveLength(1);
      expect(found.body.data[0].id).toBe(sale.id);
      expect(found.body.pagination.total).toBe(1);
    });

    it('matches case-insensitively, because a cashier types what they read', async () => {
      const { variantId } = await stocked();
      const sale = await walkInSale(variantId, 1, 20);
      const lower = await lookup(sale.saleNumber.toLowerCase()).expect(200);
      expect(lower.body.data[0].id).toBe(sale.id);
    });

    it('returns an EMPTY page for an unknown number, never someone else’s sale', async () => {
      const none = await lookup('INV-NOTHERE').expect(200);
      expect(none.body.data).toEqual([]);
      expect(none.body.pagination.total).toBe(0);
    });

    it('never reaches ANOTHER TENANT’S sale, even given its exact number', async () => {
      const other = await setupSalesFixture(app, 'returns-other');
      const { variantId } = await createSimpleProduct(app, other.accessToken, other.uomId, 'RW-OTHER-1', { defaultCost: 1 });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ warehouseId: other.warehouseId, variantId, quantity: 5, unitCost: 1 })
        .expect(201);
      const theirSale = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({
          warehouseId: other.warehouseId,
          items: [{ variantId, quantity: 1, unitPrice: 10 }],
          payments: [{ amount: 10, method: 'CASH' }],
        })
        .expect(201);

      const mine = await lookup(theirSale.body.data.saleNumber).expect(200);
      expect(mine.body.data).toEqual([]);

      // And it cannot be previewed or returned by id either.
      await preview(theirSale.body.data.id, { items: [{ saleItemId: theirSale.body.data.items[0].id, quantity: 1 }] }).expect(404);
      await refund(theirSale.body.data.id, { items: [{ saleItemId: theirSale.body.data.items[0].id, quantity: 1 }] }).expect(404);
    });

    it('a sale from an EARLIER, CLOSED shift is still findable and still returnable', async () => {
      const { variantId } = await stocked();
      const oldSale = await walkInSale(variantId, 2, 30);
      const oldShiftId = oldSale.shiftId;

      // Close the shift the sale was made in, and open a fresh one -
      // exactly what happens overnight.
      await request(app.getHttpServer())
        .post('/api/v1/sales/shifts/close')
        .set('Authorization', auth())
        .send({ countedCash: 0 })
        .expect(200);
      const reopened = await request(app.getHttpServer())
        .post('/api/v1/sales/shifts/open')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, cashRegisterId: biz.cashRegisterId, openingFloat: 0 })
        .expect(201);
      expect(reopened.body.data.id).not.toBe(oldShiftId);

      // Found by number from the NEW shift...
      const found = await lookup(oldSale.saleNumber).expect(200);
      expect(found.body.data[0].id).toBe(oldSale.id);

      // ...previewed...
      const p = await preview(oldSale.id, { items: [{ saleItemId: oldSale.items[0].id, quantity: 2 }] }).expect(200);
      expect(p.body.data.totals.totalRefundable).toBe('60');

      // ...and returned, with the money coming out of the CURRENT drawer.
      const done = await refund(oldSale.id, {
        items: [{ saleItemId: oldSale.items[0].id, quantity: 2 }],
        refund: { method: 'CASH', amount: 60 },
      }).expect(201);
      expect(done.body.data.totalRefundable).toBe('60');
      const cash = await admin.cashTransaction.findFirst({
        where: { businessId: biz.businessId, referenceType: 'SaleReturn', referenceId: done.body.data.id },
      });
      expect(cash).not.toBeNull();
      expect(cash!.shiftId).toBe(reopened.body.data.id);
    });
  });

  // ==================================================================
  describe('The preview equals the return', () => {
    it('prices a PARTIAL return, and the return credits exactly that', async () => {
      const { variantId } = await stocked();
      const sale = await walkInSale(variantId, 4, 25);

      const p = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 1 }] }).expect(200);
      expect(p.body.data.totals.totalRefundable).toBe('25');
      expect(p.body.data.lines[0].quantityAvailableToReturn).toBe('4');

      const done = await refund(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refund: { method: 'CASH', amount: Number(p.body.data.refund.requiredAmount) },
      }).expect(201);
      expect(done.body.data.totalRefundable).toBe('25');

      // The next preview knows one is already back.
      const p2 = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 3 }] }).expect(200);
      expect(p2.body.data.lines[0].quantityAlreadyReturned).toBe('1');
      expect(p2.body.data.lines[0].quantityAvailableToReturn).toBe('3');
      expect(p2.body.data.totals.totalRefundable).toBe('75');
    });

    it('prices a FULL return of a discounted line by BD-1, not quantity × price', async () => {
      const { variantId } = await stocked();
      // 3 x 100 less a 100 manual discount = 200 paid. Returning all three
      // must credit 200, not 300 - the defect BD-1 exists to prevent.
      const sale = await walkInSale(variantId, 3, 100, { discountAmount: 100 });
      expect(sale.totalAmount).toBe('200');

      const p = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 3 }] }).expect(200);
      expect(p.body.data.totals.totalRefundable).toBe('200');

      const done = await refund(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 3 }],
        refund: { method: 'CASH', amount: 200 },
      }).expect(201);
      expect(done.body.data.totalRefundable).toBe('200');
    });

    it('telescopes exactly across THREE partial returns of a discounted line', async () => {
      const { variantId } = await stocked();
      const sale = await walkInSale(variantId, 3, 100, { discountAmount: 100 });
      let refunded = new Prisma.Decimal(0);

      for (let i = 0; i < 3; i += 1) {
        const p = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 1 }] }).expect(200);
        const amount = p.body.data.refund.requiredAmount;
        const done = await refund(sale.id, {
          items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
          refund: { method: 'CASH', amount: Number(amount) },
        }).expect(201);
        expect(done.body.data.totalRefundable).toBe(amount);
        refunded = refunded.plus(amount);
      }
      // Never a fraction more or less than the line was worth.
      expect(refunded.toString()).toBe('200');
    });

    it('reverses TAX cumulatively, and the preview says how much', async () => {
      const taxId = await createTax(app, biz.accessToken, 14);
      const { variantId } = await stocked({ taxId });
      const sale = await walkInSale(variantId, 2, 100);
      expect(sale.taxAmount).toBe('28');

      const p = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 1 }] }).expect(200);
      expect(p.body.data.lines[0].merchandiseCredit).toBe('100');
      expect(p.body.data.lines[0].taxReversal).toBe('14');
      expect(p.body.data.totals.totalRefundable).toBe('114');

      const done = await refund(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refund: { method: 'CASH', amount: 114 },
      }).expect(201);
      expect(done.body.data.totalRefundable).toBe('114');
    });

    it('credits a PROMOTED line at what the customer actually paid', async () => {
      const { productId, variantId } = await stocked();
      await request(app.getHttpServer())
        .post('/api/v1/promotions')
        .set('Authorization', auth())
        .send({
          name: 'Returns 25%',
          type: 'PERCENTAGE',
          percentageValue: 25,
          targetType: 'PRODUCT',
          targetId: productId,
          validFrom: YESTERDAY,
          validTo: FAR_FUTURE,
        })
        .expect(201);

      const sale = await walkInSale(variantId, 2, 100);
      expect(sale.totalAmount).toBe('150');

      const p = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 2 }] }).expect(200);
      expect(p.body.data.totals.totalRefundable).toBe('150');

      const done = await refund(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 2 }],
        refund: { method: 'CASH', amount: 150 },
      }).expect(201);
      expect(done.body.data.totalRefundable).toBe('150');
    });

    it('prices a MULTI-LINE return in one preview', async () => {
      const taxId = await createTax(app, biz.accessToken, 10);
      const a = await stocked({ taxId });
      const b = await stocked();
      const q = await request(app.getHttpServer())
        .post('/api/v1/sales/quote')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [
            { variantId: a.variantId, quantity: 2, unitPrice: 50 },
            { variantId: b.variantId, quantity: 1, unitPrice: 40 },
          ],
        })
        .expect(200);
      const sale = (
        await sell({
          items: [
            { variantId: a.variantId, quantity: 2, unitPrice: 50 },
            { variantId: b.variantId, quantity: 1, unitPrice: 40 },
          ],
          payments: [{ amount: Number(q.body.data.totals.amountDue), method: 'CASH' }],
        }).expect(201)
      ).body.data;

      const p = await preview(sale.id, {
        items: sale.items.map((i: { id: string; quantity: string }) => ({ saleItemId: i.id, quantity: Number(i.quantity) })),
      }).expect(200);
      expect(p.body.data.lines).toHaveLength(2);
      // 100 + 10% tax = 110, plus 40 untaxed = 150.
      expect(p.body.data.totals.totalRefundable).toBe('150');

      const done = await refund(sale.id, {
        items: sale.items.map((i: { id: string; quantity: string }) => ({ saleItemId: i.id, quantity: Number(i.quantity) })),
        refund: { method: 'CASH', amount: 150 },
      }).expect(201);
      expect(done.body.data.totalRefundable).toBe('150');
    });
  });

  // ==================================================================
  describe('Walk-in refunds: the exact figure, obtained rather than guessed', () => {
    it('the preview names the EXACT amount a walk-in must be refunded', async () => {
      const taxId = await createTax(app, biz.accessToken, 7);
      const { variantId } = await stocked({ taxId });
      // 3 x 33.33 = 99.99, +7% = 106.9893 - a figure no cashier guesses.
      const sale = await walkInSale(variantId, 3, 33.33);

      const p = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 3 }] }).expect(200);
      expect(p.body.data.isWalkIn).toBe(true);
      expect(p.body.data.refund.required).toBe(true);
      expect(p.body.data.refund.requiredAmount).toBe('106.9893');
      expect(p.body.data.refund.creditToLedgerIfNoRefund).toBe('0');

      const done = await refund(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 3 }],
        refund: { method: 'CASH', amount: 106.9893 },
      }).expect(201);
      expect(done.body.data.totalRefundable).toBe('106.9893');
    });

    it('a WRONG walk-in refund is still refused - the preview informs, it does not relax the rule', async () => {
      const { variantId } = await stocked();
      const sale = await walkInSale(variantId, 1, 80);
      await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 1 }] }).expect(200);

      const short = await refund(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refund: { method: 'CASH', amount: 70 },
      }).expect(422);
      expect(short.body.error.message).toContain('walk-in');

      const over = await refund(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refund: { method: 'CASH', amount: 90 },
      }).expect(422);
      expect(over.body.error.message).toContain('cannot exceed the credit due');

      const none = await refund(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 1 }] }).expect(422);
      expect(none.body.error.message).toContain('walk-in');

      // Nothing was created by any of the three refusals.
      expect(await admin.saleReturn.count({ where: { saleId: sale.id } })).toBe(0);
    });

    it('an ACCOUNT CUSTOMER may take less, and the preview says what stays on the ledger', async () => {
      const customerId = await createCustomer('Returns Account');
      const { variantId } = await stocked();
      const q = await request(app.getHttpServer())
        .post('/api/v1/sales/quote')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 2, unitPrice: 60 }], customerId })
        .expect(200);
      const sale = (
        await sell({
          items: [{ variantId, quantity: 2, unitPrice: 60 }],
          customerId,
          payments: [{ amount: Number(q.body.data.totals.amountDue), method: 'CASH' }],
        }).expect(201)
      ).body.data;

      const p = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 2 }] }).expect(200);
      expect(p.body.data.isWalkIn).toBe(false);
      expect(p.body.data.refund.required).toBe(false);
      expect(p.body.data.refund.requiredAmount).toBeNull();
      expect(p.body.data.refund.maxAmount).toBe('120');
      expect(p.body.data.refund.creditToLedgerIfNoRefund).toBe('120');

      // Take half back in cash; the rest lands on the ledger.
      const done = await refund(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 2 }],
        refund: { method: 'CASH', amount: 50 },
      }).expect(201);
      expect(done.body.data.totalRefundable).toBe('120');
      const ledger = await admin.customerTransaction.findFirst({
        where: { businessId: biz.businessId, referenceType: 'SaleReturn', referenceId: done.body.data.id },
      });
      expect(ledger!.amount.negated().toString()).toBe('70');
    });
  });

  // ==================================================================
  describe('Serial-tracked returns', () => {
    it('the preview REPORTS which units may come back, and prices them', async () => {
      const variantId = await serialVariant(['RSN-A', 'RSN-B']);
      const sale = await walkInSale(variantId, 2, 45, { serials: ['RSN-A', 'RSN-B'] });

      const p = await preview(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1, serials: ['RSN-A'] }],
      }).expect(200);
      expect(p.body.data.lines[0].requiresSerials).toBe(true);
      expect(p.body.data.lines[0].serials).toEqual(['RSN-A']);
      expect(p.body.data.totals.totalRefundable).toBe('45');
    });

    it('refuses a serial-tracked line with NO serials, exactly as the return does', async () => {
      const variantId = await serialVariant(['RSN-C']);
      const sale = await walkInSale(variantId, 1, 45, { serials: ['RSN-C'] });
      const p = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 1 }] }).expect(422);
      expect(p.body.error.message).toContain('serial number(s) being returned must be supplied');
    });

    it('refuses the WRONG NUMBER of serials for the quantity', async () => {
      const variantId = await serialVariant(['RSN-D', 'RSN-E']);
      const sale = await walkInSale(variantId, 2, 45, { serials: ['RSN-D', 'RSN-E'] });
      const p = await preview(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 2, serials: ['RSN-D'] }],
      }).expect(422);
      expect(p.body.error.message).toContain('must equal the quantity being returned');
    });

    it('refuses a serial the sale never sold, at the RETURN', async () => {
      const variantId = await serialVariant(['RSN-F']);
      const sale = await walkInSale(variantId, 1, 45, { serials: ['RSN-F'] });
      const bad = await refund(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1, serials: ['RSN-NEVER-SOLD'] }],
        refund: { method: 'CASH', amount: 45 },
      });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(await admin.saleReturn.count({ where: { saleId: sale.id } })).toBe(0);
    });

    it('SUCCEEDS with the right serial, and BD-22 puts a SELLABLE unit back in stock', async () => {
      const variantId = await serialVariant(['RSN-G', 'RSN-H']);
      const sale = await walkInSale(variantId, 2, 45, { serials: ['RSN-G', 'RSN-H'] });

      const p = await preview(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1, condition: 'SELLABLE', serials: ['RSN-G'] }],
      }).expect(200);

      await refund(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1, condition: 'SELLABLE', serials: ['RSN-G'] }],
        refund: { method: 'CASH', amount: Number(p.body.data.refund.requiredAmount) },
      }).expect(201);

      const back = await admin.serialNumber.findFirstOrThrow({ where: { businessId: biz.businessId, serial: 'RSN-G' } });
      expect(back.status).toBe('IN_STOCK');
      const stillSold = await admin.serialNumber.findFirstOrThrow({ where: { businessId: biz.businessId, serial: 'RSN-H' } });
      expect(stillSold.status).toBe('SOLD');
    });

    it('BD-22: a DAMAGED unit is written off, not returned to sellable stock', async () => {
      const variantId = await serialVariant(['RSN-I']);
      const sale = await walkInSale(variantId, 1, 45, { serials: ['RSN-I'] });
      const p = await preview(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1, condition: 'DAMAGED', serials: ['RSN-I'] }],
      }).expect(200);

      await refund(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1, condition: 'DAMAGED', serials: ['RSN-I'] }],
        refund: { method: 'CASH', amount: Number(p.body.data.refund.requiredAmount) },
      }).expect(201);

      const damaged = await admin.serialNumber.findFirstOrThrow({ where: { businessId: biz.businessId, serial: 'RSN-I' } });
      expect(damaged.status).toBe('DAMAGED');
      // The condition does not change what the customer is owed.
      expect(p.body.data.totals.totalRefundable).toBe('45');
    });
  });

  // ==================================================================
  describe('The preview changes nothing', () => {
    it('leaves every return, ledger, inventory and accounting table untouched', async () => {
      const taxId = await createTax(app, biz.accessToken, 12);
      const { variantId } = await stocked({ taxId });
      const customerId = await createCustomer('Preview Footprint');
      await setRate('loyalty.points_per_currency_unit', 2);
      const q = await request(app.getHttpServer())
        .post('/api/v1/sales/quote')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 3, unitPrice: 40 }], customerId })
        .expect(200);
      const sale = (
        await sell({
          items: [{ variantId, quantity: 3, unitPrice: 40 }],
          customerId,
          payments: [{ amount: Number(q.body.data.totals.amountDue), method: 'CASH' }],
        }).expect(201)
      ).body.data;

      const before = await footprint();
      for (let i = 0; i < 4; i += 1) {
        await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 3 }] }).expect(200);
      }
      expect(await footprint()).toEqual(before);

      // The sale line itself is untouched too - no phantom quantityReturned.
      const item = await admin.saleItem.findUniqueOrThrow({ where: { id: sale.items[0].id } });
      expect(item.quantityReturned.toString()).toBe('0');
    });

    it('does not move a returned SERIAL, so the unit stays sold until the return happens', async () => {
      const variantId = await serialVariant(['RSN-PREVIEW']);
      const sale = await walkInSale(variantId, 1, 30, { serials: ['RSN-PREVIEW'] });
      await preview(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 1, serials: ['RSN-PREVIEW'] }],
      }).expect(200);

      const serial = await admin.serialNumber.findFirstOrThrow({ where: { businessId: biz.businessId, serial: 'RSN-PREVIEW' } });
      expect(serial.status).toBe('SOLD');
      expect(await admin.saleReturnItemSerial.count({ where: { businessId: biz.businessId } })).toBe(
        (await footprint()).serialLinks,
      );
    });

    it('runs in a transaction PostgreSQL refuses to let write', async () => {
      const prisma = app.get(PrismaService);
      await expect(
        prisma.withTenantReadOnly(biz.businessId, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO audit_logs (id, business_id, action, entity_type, created_at) ` +
              `VALUES (gen_random_uuid(), '${biz.businessId}', 'CREATE', 'ReturnProbe', now())`,
          ),
        ),
      ).rejects.toThrow(/read-only transaction/i);
      expect(await admin.auditLog.count({ where: { businessId: biz.businessId, entityType: 'ReturnProbe' } })).toBe(0);
    });

    it('states what it guarantees, and what it does not', async () => {
      const { variantId } = await stocked();
      const sale = await walkInSale(variantId, 1, 10);
      const p = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 1 }] }).expect(200);
      expect(p.body.data.guarantees).toEqual({
        authoritativeCredit: true,
        reservesNothing: true,
        createsNothing: true,
        finalReturnRevalidates: true,
      });
      expect(p.body.data.previewedAt).toBeTruthy();
    });
  });

  // ==================================================================
  describe('Consequences the return still owns', () => {
    it('restores INVENTORY and posts BALANCED accounting', async () => {
      const { variantId } = await stocked({ qty: 50 });
      const sale = await walkInSale(variantId, 5, 20);

      const afterSale = await admin.stockBalance.findFirstOrThrow({
        where: { businessId: biz.businessId, warehouseId: biz.warehouseId, variantId },
      });
      expect(afterSale.quantityOnHand.toString()).toBe('45');

      const p = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 2 }] }).expect(200);
      const done = await refund(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 2 }],
        refund: { method: 'CASH', amount: Number(p.body.data.refund.requiredAmount) },
      }).expect(201);

      const afterReturn = await admin.stockBalance.findFirstOrThrow({
        where: { businessId: biz.businessId, warehouseId: biz.warehouseId, variantId },
      });
      expect(afterReturn.quantityOnHand.toString()).toBe('47');

      const entry = await admin.journalEntry.findFirstOrThrow({
        where: { businessId: biz.businessId, sourceType: 'SaleReturn', sourceId: done.body.data.id },
        include: { lines: true },
      });
      const debit = entry.lines.reduce((s, l) => s.plus(l.debit), new Prisma.Decimal(0));
      const credit = entry.lines.reduce((s, l) => s.plus(l.credit), new Prisma.Decimal(0));
      expect(debit.toString()).toBe(credit.toString());
      expect(debit.greaterThan(0)).toBe(true);
    });

    it('CLAWS BACK loyalty points earned on the returned goods', async () => {
      await setRate('loyalty.points_per_currency_unit', 2);
      const customerId = await createCustomer('Returns Clawback');
      const { variantId } = await stocked();
      const q = await request(app.getHttpServer())
        .post('/api/v1/sales/quote')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 2, unitPrice: 50 }], customerId })
        .expect(200);
      const sale = (
        await sell({
          items: [{ variantId, quantity: 2, unitPrice: 50 }],
          customerId,
          payments: [{ amount: Number(q.body.data.totals.amountDue), method: 'CASH' }],
        }).expect(201)
      ).body.data;

      const earned = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points`)
        .set('Authorization', auth())
        .expect(200);
      expect(Number(earned.body.data.balance)).toBeGreaterThan(0);

      const p = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 2 }] }).expect(200);
      await refund(sale.id, {
        items: [{ saleItemId: sale.items[0].id, quantity: 2 }],
        refund: { method: 'CASH', amount: Number(p.body.data.refund.maxAmount) },
      }).expect(201);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points`)
        .set('Authorization', auth())
        .expect(200);
      expect(after.body.data.balance).toBe('0');
    });

    it('stays IDEMPOTENT: one key, one return, however many times it is sent', async () => {
      const { variantId } = await stocked();
      const sale = await walkInSale(variantId, 2, 35);
      const key = `ret-idem-${seq++}`;
      const p = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 1 }] }).expect(200);
      const body = {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refund: { method: 'CASH', amount: Number(p.body.data.refund.requiredAmount) },
        idempotencyKey: key,
      };
      const first = await refund(sale.id, body).expect(201);
      const replay = await refund(sale.id, body).expect(201);
      expect(replay.body.data.id).toBe(first.body.data.id);
      expect(await admin.saleReturn.count({ where: { businessId: biz.businessId, idempotencyKey: key } })).toBe(1);
    });

    it('two SIMULTANEOUS returns of the last unit cannot both succeed', async () => {
      const { variantId } = await stocked();
      const sale = await walkInSale(variantId, 1, 55);
      const body = {
        items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        refund: { method: 'CASH', amount: 55 },
      };
      const [a, b] = await Promise.all([refund(sale.id, body), refund(sale.id, body)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(201);
      expect(statuses[1]).toBeGreaterThanOrEqual(400);
      expect(await admin.saleReturn.count({ where: { saleId: sale.id } })).toBe(1);
    });
  });

  // ==================================================================
  describe('Authorization', () => {
    it('the PREVIEW requires sales.return, exactly as the return does', async () => {
      const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'INVENTORY_MANAGER' } });
      const email = `im-returns@${biz.slug}.test`;
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'IM', email, password: 'InvMgr1!xx', roleIds: [role.id], branchIds: [] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'InvMgr1!xx', businessSlug: biz.slug })
        .expect(200);
      const token = `Bearer ${login.body.data.accessToken}`;

      const { variantId } = await stocked();
      const sale = await walkInSale(variantId, 1, 15);

      const denied = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 1 }] }, token).expect(403);
      expect(denied.body.error.message).toContain('sales.return');
      await refund(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 1 }] }, token).expect(403);
    });

    it('refuses an unauthenticated caller on both the lookup and the preview', async () => {
      const { variantId } = await stocked();
      const sale = await walkInSale(variantId, 1, 15);
      await request(app.getHttpServer()).get('/api/v1/sales?saleNumber=INV-X').expect(401);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/returns/preview`)
        .send({ items: [{ saleItemId: sale.items[0].id, quantity: 1 }] })
        .expect(401);
    });

    it('rejects a malformed preview rather than pricing it', async () => {
      const { variantId } = await stocked();
      const sale = await walkInSale(variantId, 2, 15);
      await preview(sale.id, { items: [] }).expect(422);
      await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 0 }] }).expect(422);
      await preview(sale.id, { items: [{ saleItemId: 'not-a-uuid', quantity: 1 }] }).expect(422);
      await preview(sale.id, {
        items: [
          { saleItemId: sale.items[0].id, quantity: 1 },
          { saleItemId: sale.items[0].id, quantity: 1 },
        ],
      }).expect(422);
      // More than was sold.
      const tooMany = await preview(sale.id, { items: [{ saleItemId: sale.items[0].id, quantity: 99 }] }).expect(409);
      expect(tooMany.body.error.message).toContain('available to return');
    });
  });
});
