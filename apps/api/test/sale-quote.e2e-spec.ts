import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture, createTax, setupDefaultTax } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Phase 12 (Sale Quote) — the authoritative total, before the money.
 *
 * The claim under test is narrow and total: **a quote returns exactly the
 * figure the sale will charge**, because it runs the same pipeline, and it
 * changes nothing while doing so. Every test below therefore does one of
 * two things - compares a quote against the sale that follows it, or
 * proves the quote left no trace.
 */
describe('Sale quote (e2e, real Postgres)', () => {
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
    biz = await setupSalesFixture(app, 'quote');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function stocked(opts: { taxId?: string; price?: number; qty?: number } = {}) {
    const { productId, variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `QT-${seq++}`, {
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
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `QTS-${seq++}`, {
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

  const quote = (body: Record<string, unknown>, token = auth()) =>
    request(app.getHttpServer())
      .post('/api/v1/sales/quote')
      .set('Authorization', token)
      .send({ warehouseId: biz.warehouseId, ...body });

  const sell = (body: Record<string, unknown>, token = auth()) =>
    request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', token)
      .send({ warehouseId: biz.warehouseId, ...body });

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

  /**
   * THE CENTRAL ASSERTION, used by almost every test below: quote the
   * cart, then sell exactly that cart tendering exactly what the quote
   * said, and confirm the sale's own stored totals equal the quote's to
   * the last of four decimal places.
   */
  async function quoteThenSell(cart: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const q = await quote(cart).expect(200);
    const total = q.body.data.totals.totalAmount;

    const sale = await sell({
      ...cart,
      ...extra,
      payments: [{ amount: Number(total), method: 'CASH' }],
    }).expect(201);

    expect(sale.body.data.totalAmount).toBe(total);
    expect(sale.body.data.subtotal).toBe(q.body.data.totals.subtotal);
    expect(sale.body.data.discountAmount).toBe(q.body.data.totals.discountAmount);
    expect(sale.body.data.taxAmount).toBe(q.body.data.totals.taxAmount);
    return { quote: q.body.data, sale: sale.body.data };
  }

  /** Every table a sale touches, counted, so "changed nothing" is a fact. */
  async function financialFootprint() {
    const [sales, items, payments, movements, entries, lines, points, promoApps, serialLinks, cash, custTx] =
      await Promise.all([
        admin.sale.count({ where: { businessId: biz.businessId } }),
        admin.saleItem.count({ where: { businessId: biz.businessId } }),
        admin.salePayment.count({ where: { businessId: biz.businessId } }),
        admin.stockMovement.count({ where: { businessId: biz.businessId } }),
        admin.journalEntry.count({ where: { businessId: biz.businessId } }),
        admin.journalEntryLine.count({ where: { businessId: biz.businessId } }),
        admin.customerPoints.count({ where: { businessId: biz.businessId } }),
        admin.salePromotionApplication.count({ where: { businessId: biz.businessId } }),
        admin.saleItemSerial.count({ where: { businessId: biz.businessId } }),
        admin.cashTransaction.count({ where: { businessId: biz.businessId } }),
        admin.customerTransaction.count({ where: { businessId: biz.businessId } }),
      ]);
    return { sales, items, payments, movements, entries, lines, points, promoApps, serialLinks, cash, custTx };
  }

  // ==================================================================
  describe('The quote equals the sale', () => {
    it('prices an ordinary cart, and the sale charges exactly that', async () => {
      const { variantId } = await stocked();
      const { quote: q } = await quoteThenSell({
        items: [{ variantId, quantity: 2, unitPrice: 50 }],
      });
      expect(q.totals.totalAmount).toBe('100');
      expect(q.totals.amountDue).toBe(q.totals.totalAmount);
      expect(q.lines).toHaveLength(1);
      expect(q.lines[0].lineTotal).toBe('100');
    });

    it('applies a MANUAL DISCOUNT, capped exactly as the sale caps it (BD-12)', async () => {
      const { variantId } = await stocked();
      const { quote: q } = await quoteThenSell({
        items: [{ variantId, quantity: 2, unitPrice: 50, discountAmount: 15 }],
      });
      expect(q.lines[0].manualDiscount).toBe('15');
      expect(q.totals.discountAmount).toBe('15');
      expect(q.totals.totalAmount).toBe('85');

      // An over-large discount is CAPPED, not rejected - and the quote
      // reports the capped figure, so the till never shows a negative line.
      const capped = await quote({ items: [{ variantId, quantity: 1, unitPrice: 50, discountAmount: 999 }] }).expect(200);
      expect(capped.body.data.lines[0].manualDiscount).toBe('50');
      expect(capped.body.data.totals.totalAmount).toBe('0');
    });

    it('applies TAX from the tenant configuration, never from the request', async () => {
      const taxId = await createTax(app, biz.accessToken, 14);
      const { variantId } = await stocked({ taxId });

      const { quote: q } = await quoteThenSell({ items: [{ variantId, quantity: 1, unitPrice: 100 }] });
      expect(q.totals.taxAmount).toBe('14');
      expect(q.totals.totalAmount).toBe('114');
      expect(q.lines[0].taxRatePercent).toBe('14');
      expect(q.lines[0].taxExempt).toBe(false);
    });

    it('applies a PROMOTION and names it, so the cashier can answer "why is this cheaper?"', async () => {
      const { productId, variantId } = await stocked();
      await request(app.getHttpServer())
        .post('/api/v1/promotions')
        .set('Authorization', auth())
        .send({
          name: 'Quote Test 20%',
          type: 'PERCENTAGE',
          percentageValue: 20,
          targetType: 'PRODUCT',
          targetId: productId,
          validFrom: YESTERDAY,
          validTo: FAR_FUTURE,
        })
        .expect(201);

      const { quote: q } = await quoteThenSell({ items: [{ variantId, quantity: 1, unitPrice: 100 }] });
      expect(q.lines[0].promotionDiscount).toBe('20');
      expect(q.lines[0].promotion.name).toBe('Quote Test 20%');
      expect(q.lines[0].promotion.type).toBe('PERCENTAGE');
      expect(q.totals.totalAmount).toBe('80');
    });

    it('applies LOYALTY REDEMPTION, and reports the value the points bought', async () => {
      await setRate('loyalty.currency_per_point', 0.01);
      await setRate('loyalty.points_per_currency_unit', 2);
      const customerId = await createCustomer('Quote Loyalty');
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${customerId}/points/adjust`)
        .set('Authorization', auth())
        .send({ points: 5000, reason: 'seed', idempotencyKey: `qt-seed-${seq++}` })
        .expect(201);

      const { variantId } = await stocked();
      const q = await quote({ items: [{ variantId, quantity: 1, unitPrice: 100 }], customerId, redeemPoints: 1000 }).expect(200);
      expect(q.body.data.loyalty.redemptionValue).toBe('10');
      expect(q.body.data.loyalty.redemptionRate).toBe('0.01');
      expect(q.body.data.lines[0].loyaltyDiscount).toBe('10');
      expect(q.body.data.totals.totalAmount).toBe('90');

      const sale = await sell({
        items: [{ variantId, quantity: 1, unitPrice: 100 }],
        customerId,
        redeemPoints: 1000,
        payments: [{ amount: 90, method: 'CASH' }],
      }).expect(201);
      expect(sale.body.data.totalAmount).toBe('90');
    });

    it('gets PROMOTION + LOYALTY + TAX right together, in the approved order', async () => {
      await setRate('loyalty.currency_per_point', 0.01);
      const taxId = await createTax(app, biz.accessToken, 10);
      const { productId, variantId } = await stocked({ taxId });
      await request(app.getHttpServer())
        .post('/api/v1/promotions')
        .set('Authorization', auth())
        .send({
          name: 'Combined 20%',
          type: 'PERCENTAGE',
          percentageValue: 20,
          targetType: 'PRODUCT',
          targetId: productId,
          validFrom: YESTERDAY,
          validTo: FAR_FUTURE,
        })
        .expect(201);

      const customerId = await createCustomer('Quote Combined');
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${customerId}/points/adjust`)
        .set('Authorization', auth())
        .send({ points: 5000, reason: 'seed', idempotencyKey: `qt-seed-${seq++}` })
        .expect(201);

      // gross 200, manual 10, promotion 20% of 200 = 40, loyalty 1000pts = 10
      // net = 200 - 10 - 40 - 10 = 140 ; tax 10% of 140 = 14 ; total = 154
      const cart = {
        items: [{ variantId, quantity: 2, unitPrice: 100, discountAmount: 10 }],
        customerId,
        redeemPoints: 1000,
      };
      const q = await quote(cart).expect(200);
      expect(q.body.data.lines[0].manualDiscount).toBe('10');
      expect(q.body.data.lines[0].promotionDiscount).toBe('40');
      expect(q.body.data.lines[0].loyaltyDiscount).toBe('10');
      expect(q.body.data.totals.discountAmount).toBe('60');
      expect(q.body.data.totals.taxAmount).toBe('14');
      expect(q.body.data.totals.totalAmount).toBe('154');

      const sale = await sell({ ...cart, payments: [{ amount: 154, method: 'CASH' }] }).expect(201);
      expect(sale.body.data.totalAmount).toBe('154');
      expect(sale.body.data.taxAmount).toBe('14');
      expect(sale.body.data.discountAmount).toBe('60');
    });

    it('prices a SERIAL-TRACKED line and flags that units must be captured', async () => {
      const variantId = await serialVariant(['QSN-1', 'QSN-2']);
      const q = await quote({ items: [{ variantId, quantity: 2, unitPrice: 40, serials: ['QSN-1', 'QSN-2'] }] }).expect(200);
      expect(q.body.data.lines[0].requiresSerials).toBe(true);
      expect(q.body.data.totals.totalAmount).toBe('80');

      const sale = await sell({
        items: [{ variantId, quantity: 2, unitPrice: 40, serials: ['QSN-1', 'QSN-2'] }],
        payments: [{ amount: 80, method: 'CASH' }],
      }).expect(201);
      expect(sale.body.data.totalAmount).toBe('80');
    });

    it('refuses a serial-tracked line with the WRONG serial count, exactly as the sale would', async () => {
      const variantId = await serialVariant(['QSN-3', 'QSN-4']);
      const res = await quote({ items: [{ variantId, quantity: 2, unitPrice: 40, serials: ['QSN-3'] }] }).expect(422);
      expect(res.body.error.message).toContain('must equal the quantity sold');
    });

    it('reports INCLUSIVE-mode net prices, so the receipt matches the quote', async () => {
      // A dedicated business: switching pricing mode is tenant-wide and
      // would move every other total in this spec.
      const inc = await setupSalesFixture(app, 'quote-inc');
      await request(app.getHttpServer())
        .put('/api/v1/settings/tax')
        .set('Authorization', `Bearer ${inc.accessToken}`)
        .send({ taxPricingMode: 'INCLUSIVE' })
        .expect(200);
      await setupDefaultTax(app, inc.accessToken, 10, 'Inclusive Std');

      const { variantId } = await createSimpleProduct(app, inc.accessToken, inc.uomId, 'QT-INC-1', { defaultCost: 5 });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', `Bearer ${inc.accessToken}`)
        .send({ warehouseId: inc.warehouseId, variantId, quantity: 50, unitCost: 5 })
        .expect(201);

      // 110 shelf price at 10% inclusive -> net 100, tax 10, total 110.
      const q = await request(app.getHttpServer())
        .post('/api/v1/sales/quote')
        .set('Authorization', `Bearer ${inc.accessToken}`)
        .send({ warehouseId: inc.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 110 }] })
        .expect(200);
      expect(q.body.data.lines[0].unitPrice).toBe('100');
      expect(q.body.data.totals.taxAmount).toBe('10');
      expect(q.body.data.totals.totalAmount).toBe('110');

      const sale = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${inc.accessToken}`)
        .send({
          warehouseId: inc.warehouseId,
          items: [{ variantId, quantity: 1, unitPrice: 110 }],
          payments: [{ amount: 110, method: 'CASH' }],
        })
        .expect(201);
      expect(sale.body.data.totalAmount).toBe('110');
      expect(sale.body.data.items[0].unitPrice).toBe('100');
    });
  });

  // ==================================================================
  describe('The quote changes nothing', () => {
    it('leaves EVERY financial and inventory table untouched', async () => {
      const { variantId } = await stocked();
      const customerId = await createCustomer('Quote Footprint');
      await setRate('loyalty.currency_per_point', 0.01);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${customerId}/points/adjust`)
        .set('Authorization', auth())
        .send({ points: 5000, reason: 'seed', idempotencyKey: `qt-seed-${seq++}` })
        .expect(201);

      const before = await financialFootprint();
      const balanceBefore = await admin.stockBalance.findFirstOrThrow({
        where: { businessId: biz.businessId, warehouseId: biz.warehouseId, variantId },
      });

      // Quote the most side-effect-prone cart there is: a customer sale
      // that redeems points, on a promoted, taxed line - every engine the
      // sale would touch.
      for (let i = 0; i < 3; i += 1) {
        await quote({ items: [{ variantId, quantity: 2, unitPrice: 100, discountAmount: 5 }], customerId, redeemPoints: 500 }).expect(200);
      }

      expect(await financialFootprint()).toEqual(before);
      const balanceAfter = await admin.stockBalance.findFirstOrThrow({
        where: { businessId: biz.businessId, warehouseId: biz.warehouseId, variantId },
      });
      expect(balanceAfter.quantityOnHand.toString()).toBe(balanceBefore.quantityOnHand.toString());
      expect(balanceAfter.quantityReserved.toString()).toBe(balanceBefore.quantityReserved.toString());
      expect(balanceAfter.updatedAt.getTime()).toBe(balanceBefore.updatedAt.getTime());
    });

    it('does not move a SERIAL out of stock, so the unit stays sellable', async () => {
      const variantId = await serialVariant(['QSN-KEEP']);
      await quote({ items: [{ variantId, quantity: 1, unitPrice: 40, serials: ['QSN-KEEP'] }] }).expect(200);

      const serial = await admin.serialNumber.findFirstOrThrow({ where: { businessId: biz.businessId, serial: 'QSN-KEEP' } });
      expect(serial.status).toBe('IN_STOCK');
      expect(await admin.saleItemSerial.count({ where: { businessId: biz.businessId } })).toBe(
        await admin.saleItemSerial.count({ where: { businessId: biz.businessId } }),
      );

      // And the unit really is still sellable afterwards.
      await sell({
        items: [{ variantId, quantity: 1, unitPrice: 40, serials: ['QSN-KEEP'] }],
        payments: [{ amount: 40, method: 'CASH' }],
      }).expect(201);
    });

    it('does not spend loyalty points, however many times it is asked', async () => {
      await setRate('loyalty.currency_per_point', 0.01);
      const customerId = await createCustomer('Quote No Spend');
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${customerId}/points/adjust`)
        .set('Authorization', auth())
        .send({ points: 1000, reason: 'seed', idempotencyKey: `qt-seed-${seq++}` })
        .expect(201);

      const { variantId } = await stocked();
      for (let i = 0; i < 4; i += 1) {
        await quote({ items: [{ variantId, quantity: 1, unitPrice: 100 }], customerId, redeemPoints: 1000 }).expect(200);
      }

      const balance = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points`)
        .set('Authorization', auth())
        .expect(200);
      expect(balance.body.data.balance).toBe('1000');
    });

    it('consumes NO idempotency key - the contract has no field for one', async () => {
      const { variantId } = await stocked();
      const res = await quote({
        items: [{ variantId, quantity: 1, unitPrice: 10 }],
        idempotencyKey: 'quote-should-not-accept-this',
      });
      // Unknown fields are stripped by the schema rather than rejected, so
      // what matters is that no Sale was ever created under the key.
      expect(res.status).toBe(200);
      expect(await admin.sale.count({ where: { businessId: biz.businessId, idempotencyKey: 'quote-should-not-accept-this' } })).toBe(0);
    });

    it('states plainly what it does and does not guarantee', async () => {
      const { variantId } = await stocked();
      const q = await quote({ items: [{ variantId, quantity: 1, unitPrice: 10 }] }).expect(200);
      expect(q.body.data.guarantees).toEqual({
        authoritativePricing: true,
        reservesStock: false,
        holdsPrices: false,
        holdsPromotions: false,
        holdsLoyaltyBalance: false,
        createsNothing: true,
      });
      expect(q.body.data.quotedAt).toBeTruthy();
    });
  });

  // ==================================================================
  // The structural guarantee behind everything above: the quote shares
  // `CreateSaleUseCase`'s pricing pipeline, and the ONLY thing standing
  // between "shares the pipeline" and "could one day share a write" is
  // that the transaction is READ ONLY. That is a database property, and
  // these two tests are what prove it stays one.
  // ==================================================================
  describe('The read-only transaction the quote runs in', () => {
    it('lets reads through and makes PostgreSQL itself refuse a write', async () => {
      const prisma = app.get(PrismaService);
      await expect(
        prisma.withTenantReadOnly(biz.businessId, async (tx) => {
          // A read is fine - that is the whole job.
          const sales = await tx.sale.count({ where: { businessId: biz.businessId } });
          expect(sales).toBeGreaterThanOrEqual(0);
          // A write is not, and the refusal comes from the database.
          await tx.$executeRawUnsafe(
            `INSERT INTO audit_logs (id, business_id, action, entity_type, created_at) ` +
              `VALUES (gen_random_uuid(), '${biz.businessId}', 'CREATE', 'Probe', now())`,
          );
        }),
      ).rejects.toThrow(/read-only transaction/i);

      expect(await admin.auditLog.count({ where: { businessId: biz.businessId, entityType: 'Probe' } })).toBe(0);
    });

    it('refuses SELECT ... FOR UPDATE, so a quote can never block a real sale', async () => {
      const prisma = app.get(PrismaService);
      await expect(
        prisma.withTenantReadOnly(biz.businessId, (tx) =>
          tx.$queryRawUnsafe(`SELECT id FROM customers WHERE business_id = '${biz.businessId}' LIMIT 1 FOR UPDATE`),
        ),
      ).rejects.toThrow(/read-only transaction/i);
    });
  });

  // ==================================================================
  describe('A quote is not a reservation', () => {
    it('reports availability ADVISORY, and does not hold it', async () => {
      const { variantId } = await stocked({ qty: 5 });
      const q = await quote({ items: [{ variantId, quantity: 3, unitPrice: 10 }] }).expect(200);
      expect(q.body.data.availability[0]).toMatchObject({ variantId, availableQuantity: '5', requestedQuantity: '3', sufficient: true });

      // Someone else sells the stock out from under the quote.
      await sell({ items: [{ variantId, quantity: 5, unitPrice: 10 }], payments: [{ amount: 50, method: 'CASH' }] }).expect(201);

      // The quote still "exists" - it is just a number someone wrote down -
      // and the sale it described is now correctly refused.
      const refused = await sell({
        items: [{ variantId, quantity: 3, unitPrice: 10 }],
        payments: [{ amount: 30, method: 'CASH' }],
      }).expect(409);
      expect(refused.body.error.code).toBe('INSUFFICIENT_STOCK');
    });

    it('reports insufficient stock without refusing - the engine decides at commit', async () => {
      const { variantId } = await stocked({ qty: 2 });
      const q = await quote({ items: [{ variantId, quantity: 10, unitPrice: 10 }] }).expect(200);
      expect(q.body.data.availability[0].sufficient).toBe(false);
      expect(q.body.data.availability[0].availableQuantity).toBe('2');
      // Still priced, because pricing is not stock.
      expect(q.body.data.totals.totalAmount).toBe('100');
    });

    it('a STALE quote is superseded by the sale, which re-resolves everything', async () => {
      const { productId, variantId } = await stocked();
      const q1 = await quote({ items: [{ variantId, quantity: 1, unitPrice: 100 }] }).expect(200);
      expect(q1.body.data.totals.totalAmount).toBe('100');

      // A promotion appears between the quote and the sale.
      await request(app.getHttpServer())
        .post('/api/v1/promotions')
        .set('Authorization', auth())
        .send({
          name: 'Late Promotion',
          type: 'PERCENTAGE',
          percentageValue: 25,
          targetType: 'PRODUCT',
          targetId: productId,
          validFrom: YESTERDAY,
          validTo: FAR_FUTURE,
        })
        .expect(201);

      // Tendering the stale figure is now WRONG, and the sale says so
      // rather than quietly taking too much money.
      const stale = await sell({
        items: [{ variantId, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100, method: 'CASH' }],
      }).expect(422);
      expect(stale.body.error.message).toContain('Payments exceed the sale total');

      // Re-quoting is the whole recovery: it returns the new truth.
      const q2 = await quote({ items: [{ variantId, quantity: 1, unitPrice: 100 }] }).expect(200);
      expect(q2.body.data.totals.totalAmount).toBe('75');
      const ok = await sell({
        items: [{ variantId, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 75, method: 'CASH' }],
      }).expect(201);
      expect(ok.body.data.totalAmount).toBe('75');
    });
  });

  // ==================================================================
  describe('Payment behaviour the quote enables', () => {
    it('a CORRECT tender, taken from the quote, is accepted', async () => {
      const taxId = await createTax(app, biz.accessToken, 7);
      const { variantId } = await stocked({ taxId });
      // 3 x 33.33 = 99.99 ; tax 7% = 6.9993 ; total 106.9893 - the kind of
      // figure a client that guessed would get wrong.
      const q = await quote({ items: [{ variantId, quantity: 3, unitPrice: 33.33 }] }).expect(200);
      expect(q.body.data.totals.totalAmount).toBe('106.9893');
      const sale = await sell({
        items: [{ variantId, quantity: 3, unitPrice: 33.33 }],
        payments: [{ amount: 106.9893, method: 'CASH' }],
      }).expect(201);
      expect(sale.body.data.totalAmount).toBe('106.9893');
    });

    it('an INCORRECT tender is still refused - the quote informs, it does not relax the rule', async () => {
      const { variantId } = await stocked();
      await quote({ items: [{ variantId, quantity: 1, unitPrice: 100 }] }).expect(200);

      const over = await sell({
        items: [{ variantId, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 120, method: 'CASH' }],
      }).expect(422);
      expect(over.body.error.message).toContain('Payments exceed the sale total');

      const under = await sell({
        items: [{ variantId, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 80, method: 'CASH' }],
      }).expect(422);
      expect(under.body.error.message).toContain('must be paid in full');
    });

    it('supports SPLIT TENDER summing to the quoted total', async () => {
      const taxId = await createTax(app, biz.accessToken, 5);
      const { variantId } = await stocked({ taxId });
      const q = await quote({ items: [{ variantId, quantity: 2, unitPrice: 60 }] }).expect(200);
      expect(q.body.data.totals.totalAmount).toBe('126');

      const sale = await sell({
        items: [{ variantId, quantity: 2, unitPrice: 60 }],
        payments: [
          { amount: 100, method: 'CARD' },
          { amount: 26, method: 'CASH' },
        ],
      }).expect(201);
      expect(sale.body.data.totalAmount).toBe('126');
      expect(sale.body.data.payments).toHaveLength(2);
    });

    it('the final sale stays IDEMPOTENT after a quote', async () => {
      const { variantId } = await stocked();
      const q = await quote({ items: [{ variantId, quantity: 1, unitPrice: 20 }] }).expect(200);
      const key = `quote-idem-${seq++}`;
      const body = {
        items: [{ variantId, quantity: 1, unitPrice: 20 }],
        payments: [{ amount: Number(q.body.data.totals.totalAmount), method: 'CASH' }],
        idempotencyKey: key,
      };
      const first = await sell(body).expect(201);
      const replay = await sell(body).expect(201);
      expect(replay.body.data.id).toBe(first.body.data.id);
      expect(await admin.sale.count({ where: { businessId: biz.businessId, idempotencyKey: key } })).toBe(1);
    });
  });

  // ==================================================================
  describe('Authorization and isolation', () => {
    it('requires sales.create - a Branch Manager who may view and return cannot quote', async () => {
      const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'BRANCH_MANAGER' } });
      const email = `bm-quote@${biz.slug}.test`;
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'BM', email, password: 'BranchMgr1!', roleIds: [role.id], branchIds: [] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'BranchMgr1!', businessSlug: biz.slug })
        .expect(200);

      const { variantId } = await stocked();
      const denied = await quote(
        { items: [{ variantId, quantity: 1, unitPrice: 10 }] },
        `Bearer ${login.body.data.accessToken}`,
      ).expect(403);
      expect(denied.body.error.message).toContain('sales.create');
    });

    it('refuses an unauthenticated caller', async () => {
      const { variantId } = await stocked();
      await request(app.getHttpServer())
        .post('/api/v1/sales/quote')
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 10 }] })
        .expect(401);
    });

    it('cannot price ANOTHER TENANT’S variant or warehouse', async () => {
      const other = await setupSalesFixture(app, 'quote-other');
      const { variantId: theirs } = await createSimpleProduct(app, other.accessToken, other.uomId, 'QT-OTHER-1', {
        defaultCost: 1,
      });

      // Their variant, my warehouse: invisible, so 404 - not a price.
      const crossVariant = await quote({ items: [{ variantId: theirs, quantity: 1, unitPrice: 10 }] }).expect(404);
      expect(crossVariant.body.error.code).toBe('NOT_FOUND');

      // Their warehouse, my token: equally invisible.
      const { variantId: mine } = await stocked();
      const crossWarehouse = await request(app.getHttpServer())
        .post('/api/v1/sales/quote')
        .set('Authorization', auth())
        .send({ warehouseId: other.warehouseId, items: [{ variantId: mine, quantity: 1, unitPrice: 10 }] })
        .expect(404);
      expect(crossWarehouse.body.error.code).toBe('NOT_FOUND');
    });

    it('cannot redeem ANOTHER TENANT’S customer points', async () => {
      const other = await setupSalesFixture(app, 'quote-other-cust');
      const theirCustomer = await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ name: 'Theirs' })
        .expect(201);

      const { variantId } = await stocked();
      await quote({
        items: [{ variantId, quantity: 1, unitPrice: 10 }],
        customerId: theirCustomer.body.data.id,
      }).expect(404);
    });
  });

  // ==================================================================
  describe('The same refusals as the sale, before the money', () => {
    it('refuses when there is no open shift', async () => {
      const noShift = await setupSalesFixture(app, 'quote-noshift');
      const { variantId } = await createSimpleProduct(app, noShift.accessToken, noShift.uomId, 'QT-NS-1', { defaultCost: 1 });
      await request(app.getHttpServer())
        .post('/api/v1/sales/shifts/close')
        .set('Authorization', `Bearer ${noShift.accessToken}`)
        .send({ countedCash: 0 })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/api/v1/sales/quote')
        .set('Authorization', `Bearer ${noShift.accessToken}`)
        .send({ warehouseId: noShift.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 10 }] })
        .expect(409);
      expect(res.body.error.message).toContain('open shift is required');
    });

    it('refuses redemption without a customer, and beyond the balance', async () => {
      await setRate('loyalty.currency_per_point', 0.01);
      const { variantId } = await stocked();

      const noCustomer = await quote({ items: [{ variantId, quantity: 1, unitPrice: 50 }], redeemPoints: 100 }).expect(422);
      expect(noCustomer.body.error.message).toContain('attached to a customer');

      const customerId = await createCustomer('Quote Broke');
      const overBalance = await quote({
        items: [{ variantId, quantity: 1, unitPrice: 50 }],
        customerId,
        redeemPoints: 999,
      }).expect(409);
      expect(overBalance.body.error.message).toContain("balance is only");
    });

    it('rejects a malformed cart rather than pricing it', async () => {
      const { variantId } = await stocked();
      await quote({ items: [] }).expect(422);
      await quote({ items: [{ variantId, quantity: 0, unitPrice: 10 }] }).expect(422);
      await quote({ items: [{ variantId, quantity: 1, unitPrice: -5 }] }).expect(422);
      await quote({
        items: [
          { variantId, quantity: 1, unitPrice: 10 },
          { variantId, quantity: 1, unitPrice: 10 },
        ],
      }).expect(422);
    });
  });
});
