import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture, createTax } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 8C / BD-1 - the six mandated regressions for the Sale Return
 * credit correction, plus the arithmetic-alignment guarantee it rests on.
 *
 * Phase 5 credited `quantity x unitPrice` and ignored `discountAmount`
 * entirely, so ANY discounted line could be returned for more than the
 * customer ever paid. These tests exist to make that defect
 * unrepresentable, and they assert against real PostgreSQL rows, never
 * against the response body alone.
 */
describe('Sale return credit - BD-1 historical effective value (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let customerId: string;

  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'bd1');
    customerId = await createCustomer('BD-1 Customer');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function createCustomer(name: string) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales/customers')
      .set('Authorization', auth())
      .send({ name })
      .expect(201);
    return res.body.data.id as string;
  }

  /** One sale, one line, with a caller-supplied discount. A promotion
   * engine (Phase 8D) will write the same snapshot fields, so proving the
   * arithmetic here proves it for promotional discounts too - BD-1
   * operates on the stored SaleItem snapshot, never on how the discount
   * arose.
   *
   * Phase 10 (BD-18): the caller no longer supplies tax. A line that needs
   * tax gets a real tax attached to its own product, so the figure the
   * assertions below use is one the SERVER computed. The rate is attached
   * per product rather than as the business default, which would silently
   * change the total of every other sale in this spec. */
  const taxIdByRate = new Map<number, string>();
  async function taxOfRate(ratePercent: number): Promise<string> {
    let id = taxIdByRate.get(ratePercent);
    if (!id) {
      id = await createTax(app, biz.accessToken, ratePercent);
      taxIdByRate.set(ratePercent, id);
    }
    return id;
  }

  async function sellOneLine(sku: string, quantity: number, unitPrice: number, discountAmount: number, taxRatePercent = 0) {
    const taxId = taxRatePercent > 0 ? await taxOfRate(taxRatePercent) : undefined;
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, sku, { defaultCost: 1, taxId });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: quantity + 50, unitCost: 1 })
      .expect(201);

    // BD-12: the manual discount is capped at the line gross, so the
    // amount actually owed follows the capped figure. BD-18: tax is then
    // charged on that capped, discounted net - never on the gross - so a
    // fully-discounted line attracts no tax at all.
    const gross = unitPrice * quantity;
    const net = gross - Math.min(discountAmount, gross);
    const total = net + (net * taxRatePercent) / 100;
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        customerId,
        items: [{ variantId, quantity, unitPrice, discountAmount }],
        payments: total > 0 ? [{ amount: total }] : [],
      })
      .expect(201);
    return { saleId: res.body.data.id as string, saleItemId: res.body.data.items[0].id as string, variantId };
  }

  function returnUnits(saleId: string, saleItemId: string, quantity: number) {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity, condition: 'SELLABLE' }] });
  }

  /** The credit actually recorded for a return: the customer-ledger row
   * the return wrote. Read from the database, not the API response. */
  async function creditFor(saleReturnId: string) {
    const txn = await admin.customerTransaction.findFirst({
      where: { referenceType: 'SaleReturn', referenceId: saleReturnId, type: 'SALE_RETURN' },
    });
    return txn ? txn.amount.negated() : D(0);
  }

  async function totalCreditForSale(saleId: string) {
    const returns = await admin.saleReturn.findMany({ where: { saleId }, select: { id: true } });
    let sum = D(0);
    for (const r of returns) sum = sum.plus(await creditFor(r.id));
    return sum;
  }

  // ------------------------------------------------------------------
  it('REGRESSION 1 - a manual discount cannot be over-refunded', async () => {
    // 10 units at 50 = 500 gross, 100 manual discount => 400 merchandise.
    const { saleId, saleItemId } = await sellOneLine('BD1-MANUAL', 10, 50, 100);
    const res = await returnUnits(saleId, saleItemId, 10).expect(201);
    const credit = await creditFor(res.body.data.id);

    expect(credit.toString()).toBe('400');
    // The pre-fix calculation would have refunded 10 x 50 = 500.
    expect(credit.lessThan(500)).toBe(true);
  });

  it('REGRESSION 2 - a percentage-style discount cannot be over-refunded', async () => {
    // 20% off 8 units at 25 = 200 gross, 40 discount => 160 merchandise.
    const { saleId, saleItemId } = await sellOneLine('BD1-PCT', 8, 25, 40);
    const res = await returnUnits(saleId, saleItemId, 8).expect(201);
    expect((await creditFor(res.body.data.id)).toString()).toBe('160');
  });

  it('REGRESSION 3 - a fixed-amount discount cannot be over-refunded', async () => {
    // 4 units at 30 = 120 gross, flat 20 off => 100 merchandise.
    const { saleId, saleItemId } = await sellOneLine('BD1-FIXED', 4, 30, 20);
    const res = await returnUnits(saleId, saleItemId, 4).expect(201);
    expect((await creditFor(res.body.data.id)).toString()).toBe('100');
  });

  it('REGRESSION 4 - Buy-X-Get-Y cannot be over-refunded (the original defect)', async () => {
    // The exact BD-1 example: quantity 3, unitPrice 100, discount 100.
    // The customer paid 200. Returning all three MUST refund 200, never 300.
    const { saleId, saleItemId } = await sellOneLine('BD1-BXGY', 3, 100, 100);
    const res = await returnUnits(saleId, saleItemId, 3).expect(201);
    expect((await creditFor(res.body.data.id)).toString()).toBe('200');
  });

  it('REGRESSION 5 - sequential partial returns never exceed, and cumulatively equal, the historical line value', async () => {
    // The rounding trap: 200/3 = 66.6667 at 4dp, so three naive partial
    // refunds would total 200.0001 - more than the line was ever worth.
    const { saleId, saleItemId } = await sellOneLine('BD1-PARTIAL', 3, 100, 100);

    const credits: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await returnUnits(saleId, saleItemId, 1).expect(201);
      credits.push((await creditFor(res.body.data.id)).toString());
    }
    expect(credits).toEqual(['66.6667', '66.6666', '66.6667']);

    const total = await totalCreditForSale(saleId);
    expect(total.toString()).toBe('200');
    expect(total.equals(200)).toBe(true);

    // A fourth unit does not exist - the quantity bound still holds.
    await returnUnits(saleId, saleItemId, 1).expect(409);
  });

  it('REGRESSION 6 - concurrent returns remain bounded by the historical line value', async () => {
    const { saleId, saleItemId } = await sellOneLine('BD1-CONC', 4, 100, 100); // 300 merchandise

    // Fired simultaneously against the same line; the Sale-row lock plus
    // the quantity bound must keep the combined credit inside 300.
    const results = await Promise.all([returnUnits(saleId, saleItemId, 3), returnUnits(saleId, saleItemId, 3)]);
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);

    const item = await admin.saleItem.findUniqueOrThrow({ where: { id: saleItemId } });
    expect(item.quantityReturned.lessThanOrEqualTo(item.quantity)).toBe(true);

    const total = await totalCreditForSale(saleId);
    expect(total.lessThanOrEqualTo(300)).toBe(true);
  });

  // ------------------------------------------------------------------
  it('excludes tax from the credit - the stored lineTotal INCLUDES tax and must not be used', async () => {
    // 2 units at 100 = 200 gross, 50 discount, 20% tax on the net 150 = 30.
    // lineTotal stored = 200 - 50 + 30 = 180, but merchandise = 150.
    const { saleId, saleItemId } = await sellOneLine('BD1-TAX', 2, 100, 50, 20);
    const item = await admin.saleItem.findUniqueOrThrow({ where: { id: saleItemId } });
    expect(item.lineTotal.toString()).toBe('180');

    const res = await returnUnits(saleId, saleItemId, 2).expect(201);

    // BD-1's subject is the MERCHANDISE credit, and it is 150 - the stored
    // lineTotal of 180 must never be used as the credit basis. The GL is
    // where the two columns are separately visible, so assert there.
    const entry = await admin.journalEntry.findFirstOrThrow({
      where: { sourceType: 'SaleReturn', sourceId: res.body.data.id },
      include: { lines: { include: { account: true } } },
    });
    const debitOn = (type: string) =>
      entry.lines
        .filter((l) => l.account.type === type)
        .reduce((sum, l) => sum.plus(l.debit), D(0))
        .toString();

    // Revenue is reversed by the MERCHANDISE value only: 150, not the 180
    // lineTotal and not the 200 gross a pre-BD-1 calculation produced.
    expect(debitOn('REVENUE')).toBe('150');

    // Phase 10 (BD-18) adds the second column: the 30 of tax the customer
    // was charged comes off the tax liability in its own right, computed by
    // BD-1's cumulative method rather than as a fresh proportion.
    const taxPayable = entry.lines.filter((l) => l.account.type === 'LIABILITY');
    expect(taxPayable.reduce((sum, l) => sum.plus(l.debit), D(0)).toString()).toBe('30');

    // The customer's ledger is therefore credited 180 - exactly what the
    // sale debited them for this line. Crediting only the merchandise would
    // strand a permanent 30 debit against goods they handed back. The 150
    // above is what guarantees this is 180 rather than the 230 the pre-BD-1
    // calculation would have produced.
    expect((await creditFor(res.body.data.id)).toString()).toBe('180');
  });

  it('an undiscounted line is unchanged by the fix - Phase 5 behaviour preserved exactly', async () => {
    const { saleId, saleItemId } = await sellOneLine('BD1-PLAIN', 5, 20, 0);
    const res = await returnUnits(saleId, saleItemId, 2).expect(201);
    expect((await creditFor(res.body.data.id)).toString()).toBe('40');
  });

  it('integer-quantity sales are bit-identical after the subtotal rounding alignment', async () => {
    const { saleId } = await sellOneLine('BD1-SUBTOTAL', 7, 13.37, 0);
    const sale = await admin.sale.findUniqueOrThrow({ where: { id: saleId } });
    // 7 x 13.37 = 93.59 exactly; rounding to the monetary scale is the
    // identity here, so the stored subtotal is what Phase 5 produced.
    expect(sale.subtotal.toString()).toBe('93.59');
  });

  it('a fractional-quantity line still returns exactly its merchandise value', async () => {
    // 2.5 x 3.3333 = 8.33325, which the monetary scale rounds to 8.3333.
    const { saleId, saleItemId } = await sellOneLine('BD1-FRACTION', 2.5, 3.3333, 0);
    const sale = await admin.sale.findUniqueOrThrow({ where: { id: saleId } });
    expect(sale.subtotal.toString()).toBe('8.3333');

    await returnUnits(saleId, saleItemId, 1).expect(201);
    await returnUnits(saleId, saleItemId, 1).expect(201);
    await returnUnits(saleId, saleItemId, 0.5).expect(201);
    expect((await totalCreditForSale(saleId)).toString()).toBe('8.3333');
  });

  // ------------------------------------------------------------------
  // Phase 8E / BD-12: a manual discount may never exceed the line gross.
  // Before the cap, `merchandiseValue = gross - discount` went NEGATIVE
  // whenever tax gave the discount headroom, and the customer returning
  // the goods was silently credited nothing while the stock came back.
  // ------------------------------------------------------------------
  describe('BD-12 - the manual discount is capped at the line gross', () => {
    it('caps an over-discounted line and never produces negative merchandise value', async () => {
      // gross 100, requested discount 110, a 20% tax on the product. The
      // old CHECK (line_total >= 0) accepted this; the discount is now
      // capped at 100.
      const { saleId, saleItemId } = await sellOneLine('BD12-CAP', 1, 100, 110, 20);
      const sale = await admin.sale.findUniqueOrThrow({ where: { id: saleId }, include: { items: true } });

      expect(sale.discountAmount.toString()).toBe('100');
      expect(sale.items[0].discountAmount.toString()).toBe('100');
      // Merchandise value is zero, never negative.
      expect(sale.subtotal.minus(sale.discountAmount).toString()).toBe('0');
      // BEHAVIOURAL CORRECTION, Phase 10 (BD-18). This line used to assert
      // that the customer "still owes the tax" of 20, because the caller
      // supplied the tax figure directly and nothing related it to the
      // discount. Tax is now computed by the server on the DISCOUNTED net,
      // so a line discounted to zero is taxed at zero - which is both the
      // approved rule and what any tax authority would expect. The total is
      // therefore 0, not 20.
      expect(sale.totalAmount.toString()).toBe('0');
      expect(sale.items[0].lineTotal.toString()).toBe('0');
      expect(sale.items[0].taxAmount.toString()).toBe('0');
      expect(sale.discountAmount.toString()).toBe(
        sale.items.reduce((s, i) => s.plus(i.discountAmount), D(0)).toString(),
      );

      // ...and because nothing is owed, no CustomerTransaction is written
      // at all: a zero-amount ledger row carries no information and is
      // rejected by the `customer_transactions` non-zero CHECK. This
      // exercises the zero-total guard in CreateSaleUseCase directly.
      const txn = await admin.customerTransaction.findFirst({
        where: { referenceType: 'Sale', referenceId: saleId, type: 'SALE' },
      });
      expect(txn).toBeNull();

      // Returning it credits exactly zero - never a negative credit that
      // would charge the customer for handing goods back.
      const ret = await returnUnits(saleId, saleItemId, 1).expect(201);
      const credit = await creditFor(ret.body.data.id);
      expect(credit.toString()).toBe('0');
      expect(credit.greaterThanOrEqualTo(0)).toBe(true);
    });

    it('the GL entry for a fully-discounted line stays balanced with no negative reversal', async () => {
      const { saleId, saleItemId } = await sellOneLine('BD12-GL', 2, 50, 500, 10); // 10% tax on a net of zero = zero
      const entry = await admin.journalEntry.findFirstOrThrow({
        where: { sourceType: 'Sale', sourceId: saleId },
        include: { lines: true },
      });
      const debit = entry.lines.reduce((s, l) => s.plus(l.debit), D(0));
      const credit = entry.lines.reduce((s, l) => s.plus(l.credit), D(0));
      expect(debit.toString()).toBe(credit.toString());
      expect(entry.lines.every((l) => l.debit.greaterThanOrEqualTo(0) && l.credit.greaterThanOrEqualTo(0))).toBe(true);

      const ret = await returnUnits(saleId, saleItemId, 2).expect(201);
      const retEntry = await admin.journalEntry.findFirstOrThrow({
        where: { sourceType: 'SaleReturn', sourceId: ret.body.data.id },
        include: { lines: true },
      });
      const rd = retEntry.lines.reduce((s, l) => s.plus(l.debit), D(0));
      const rc = retEntry.lines.reduce((s, l) => s.plus(l.credit), D(0));
      expect(rd.toString()).toBe(rc.toString());
      // No revenue reversal line at all - there was no merchandise revenue.
      expect(retEntry.lines.every((l) => l.debit.greaterThanOrEqualTo(0))).toBe(true);
    });

    it('loyalty clawback and restoration stay correct and non-negative on a capped line', async () => {
      await request(app.getHttpServer()).put('/api/v1/settings').set('Authorization', auth()).send({ key: 'loyalty.points_per_currency_unit', value: 2 }).expect(200);

      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'BD12-LOY', { defaultCost: 1 });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 50, unitCost: 1 })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          customerId,
          items: [{ variantId, quantity: 1, unitPrice: 100, discountAmount: 150 }],
          // Phase 10 (BD-18): the discount caps at the gross, leaving a net
          // of zero, so the server charges no tax and there is nothing to
          // tender. This used to carry a caller-supplied tax of 30.
          payments: [],
        })
        .expect(201);

      // Basis is zero, so nothing is earned - and nothing can be clawed back.
      const earn = await admin.customerPoints.findFirst({ where: { referenceId: res.body.data.id, type: 'EARN' } });
      expect(earn).toBeNull();

      const before = await admin.customerPoints.count({ where: { customerId } });
      await returnUnits(res.body.data.id, res.body.data.items[0].id, 1).expect(201);
      // No clawback and no restoration rows - there was nothing to reverse.
      expect(await admin.customerPoints.count({ where: { customerId } })).toBe(before);

      const rows: Array<{ customer_id: string }> = await admin.$queryRawUnsafe(
        `SELECT customer_id FROM customer_points GROUP BY customer_id HAVING SUM(points) < 0`,
      );
      expect(rows).toEqual([]);

      await request(app.getHttpServer()).put('/api/v1/settings').set('Authorization', auth()).send({ key: 'loyalty.points_per_currency_unit', value: null }).expect(200);
    });

    it('every existing valid discount is completely unchanged by the cap', async () => {
      // The cap is the identity for any well-formed line.
      const { saleId, saleItemId } = await sellOneLine('BD12-IDENTITY', 4, 25, 40);
      const sale = await admin.sale.findUniqueOrThrow({ where: { id: saleId }, include: { items: true } });
      expect(sale.subtotal.toString()).toBe('100');
      expect(sale.discountAmount.toString()).toBe('40');
      expect(sale.items[0].discountAmount.toString()).toBe('40');
      expect(sale.totalAmount.toString()).toBe('60');

      const ret = await returnUnits(saleId, saleItemId, 4).expect(201);
      expect((await creditFor(ret.body.data.id)).toString()).toBe('60');
    });

    it('no sale line in the database has a discount exceeding its own gross', async () => {
      const rows: Array<{ id: string }> = await admin.$queryRawUnsafe(`
        SELECT id FROM sale_items WHERE discount_amount > round(unit_price * quantity, 4)
      `);
      expect(rows).toEqual([]);
    });
  });

  it('the GL revenue reversal uses the corrected credit, not the old gross figure', async () => {
    const { saleId, saleItemId } = await sellOneLine('BD1-GL', 3, 100, 100);
    const res = await returnUnits(saleId, saleItemId, 3).expect(201);

    const entry = await admin.journalEntry.findFirstOrThrow({
      where: { businessId: biz.businessId, sourceType: 'SaleReturn', sourceId: res.body.data.id },
      include: { lines: { include: { account: true } } },
    });
    const revenueLine = entry.lines.find((l) => l.account.name.toLowerCase().includes('revenue'));
    expect(revenueLine).toBeDefined();
    // 200, the historical merchandise value - not 300.
    expect(revenueLine!.debit.toString()).toBe('200');
  });
});
