import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
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
   * arose. */
  async function sellOneLine(sku: string, quantity: number, unitPrice: number, discountAmount: number, taxAmount = 0) {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, sku, { defaultCost: 1 });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: quantity + 50, unitCost: 1 })
      .expect(201);

    const total = unitPrice * quantity - discountAmount + taxAmount;
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        customerId,
        items: [{ variantId, quantity, unitPrice, discountAmount, taxAmount }],
        payments: [{ amount: total }],
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
    // 2 units at 100 = 200 gross, 50 discount, 30 tax.
    // lineTotal stored = 200 - 50 + 30 = 180, but merchandise = 150.
    const { saleId, saleItemId } = await sellOneLine('BD1-TAX', 2, 100, 50, 30);
    const item = await admin.saleItem.findUniqueOrThrow({ where: { id: saleItemId } });
    expect(item.lineTotal.toString()).toBe('180');

    const res = await returnUnits(saleId, saleItemId, 2).expect(201);
    expect((await creditFor(res.body.data.id)).toString()).toBe('150');
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
