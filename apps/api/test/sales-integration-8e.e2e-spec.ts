import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 8E - the final Sales integration proof. Everything here runs
 * against a real NestJS app and real PostgreSQL with RLS + FORCE RLS
 * active. No mocks: serial ownership, lock ordering, idempotency under
 * true concurrency and historical immutability are integrity invariants
 * a mock cannot prove.
 */
describe('Phase 8E: cross-feature integration, serials and concurrency (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;

  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
  let seq = 0;
  const key = (p: string) => `${p}-${Date.now()}-${seq++}`;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, '8e');
    await setSetting('loyalty.currency_per_point', 0.01);
    await setSetting('loyalty.points_per_currency_unit', 2);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function setSetting(k: string, value: unknown) {
    await request(app.getHttpServer()).put('/api/v1/settings').set('Authorization', auth()).send({ key: k, value }).expect(200);
  }

  async function customer(name: string) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales/customers')
      .set('Authorization', auth())
      .send({ name })
      .expect(201);
    return res.body.data.id as string;
  }

  async function grantPoints(customerId: string, points: number) {
    await request(app.getHttpServer())
      .post(`/api/v1/sales/customers/${customerId}/points/adjust`)
      .set('Authorization', auth())
      .send({ points, reason: 'seed', idempotencyKey: key('seed') })
      .expect(201);
  }

  async function plainVariant(sku: string, qty = 500) {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, sku, { defaultCost: 1 });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: qty, unitCost: 1 })
      .expect(201);
    return variantId;
  }

  /** A serial-tracked variant with `serials` received into stock. */
  async function serialVariant(sku: string, serials: string[]) {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, sku, {
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

  function sell(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, ...body });
  }

  /**
   * Phase 10 (BD-23): a walk-in return must be refunded in full, so this
   * helper takes the refund alongside the lines. Passing `refund` through
   * rather than deriving it keeps each test explicit about the money it
   * expects to hand back.
   */
  function returnItems(
    saleId: string,
    items: Record<string, unknown>[],
    idempotencyKey?: string,
    refund?: { method: string; amount: number },
  ) {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/returns`)
      .set('Authorization', auth())
      .send({ items, idempotencyKey, refund });
  }

  async function promo(body: Record<string, unknown>) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/promotions')
      .set('Authorization', auth())
      .send({ validFrom: '2020-01-01', validTo: '2099-12-31', ...body })
      .expect(201);
    return res.body.data.id as string;
  }

  // ------------------------------------------------------------------
  describe('The full stack on one sale: promotion + manual + redemption + earning', () => {
    let saleId: string;
    let saleItemId: string;
    let custId: string;

    it('composes all four discounts in the approved order and earns on the final net', async () => {
      custId = await customer('Full Stack');
      await grantPoints(custId, 5000);
      const variantId = await plainVariant('E2E-STACK');
      await promo({ name: '10pct', type: 'PERCENTAGE', percentageValue: 10, targetType: 'VARIANT', targetId: variantId });

      // gross 400, manual 40, promotion 40 (10% of gross, not of 360),
      // redemption 50 -> discount 130, total 270, earns floor(270 x 2).
      const res = await sell({
        customerId: custId,
        items: [{ variantId, quantity: 4, unitPrice: 100, discountAmount: 40 }],
        redeemPoints: 5000,
        payments: [{ amount: 270 }],
      }).expect(201);
      saleId = res.body.data.id;
      saleItemId = res.body.data.items[0].id;

      const sale = await admin.sale.findUniqueOrThrow({ where: { id: saleId }, include: { items: true } });
      expect(sale.subtotal.toString()).toBe('400');
      expect(sale.discountAmount.toString()).toBe('130');
      expect(sale.totalAmount.toString()).toBe('270');
      expect(sale.items[0].discountAmount.toString()).toBe('130');
      expect(sale.discountAmount.toString()).toBe(
        sale.items.reduce((s, i) => s.plus(i.discountAmount), D(0)).toString(),
      );

      const earn = await admin.customerPoints.findFirstOrThrow({ where: { referenceId: saleId, type: 'EARN' } });
      expect(earn.basisAmount!.toString()).toBe('270');
      expect(earn.points.toString()).toBe('540');

      const redeem = await admin.customerPoints.findFirstOrThrow({ where: { referenceId: saleId, type: 'REDEEM' } });
      expect(redeem.points.toString()).toBe('-5000');

      const entry = await admin.journalEntry.findFirstOrThrow({ where: { sourceType: 'Sale', sourceId: saleId }, include: { lines: true } });
      expect(entry.lines.reduce((s, l) => s.plus(l.debit), D(0)).toString()).toBe(
        entry.lines.reduce((s, l) => s.plus(l.credit), D(0)).toString(),
      );
    });

    it('sequential partial returns of that sale telescope exactly for credit, clawback and restoration', async () => {
      const credits: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await returnItems(saleId, [{ saleItemId, quantity: 1, condition: 'SELLABLE' }]).expect(201);
        const txn = await admin.customerTransaction.findFirstOrThrow({
          where: { referenceType: 'SaleReturn', referenceId: r.body.data.id, type: 'SALE_RETURN' },
        });
        credits.push(txn.amount.negated().toString());
      }
      // Merchandise value was 400 - 130 = 270, split over 4 units.
      expect(credits.reduce((s, c) => D(s).plus(c).toString(), '0')).toBe('270');

      const events = await admin.customerPoints.findMany({ where: { customerId: custId } });
      const claw = events.filter((e) => e.type === 'RETURN_CLAWBACK').reduce((s, e) => s.plus(e.points), D(0));
      const restored = events.filter((e) => e.type === 'REDEMPTION_RESTORATION').reduce((s, e) => s.plus(e.points), D(0));
      expect(claw.toString()).toBe('-540');
      expect(restored.toString()).toBe('5000');
      // Back to exactly the original grant.
      expect(events.reduce((s, e) => s.plus(e.points), D(0)).toString()).toBe('5000');
    });

    it('changing ALL FOUR configuration values afterwards changes nothing about that sale', async () => {
      const before = await admin.sale.findUniqueOrThrow({ where: { id: saleId }, include: { items: true } });
      const appsBefore = await admin.salePromotionApplication.findMany({ where: { saleId } });
      const pointsBefore = await admin.customerPoints.findMany({ where: { referenceId: saleId } });

      await setSetting('loyalty.currency_per_point', 9);
      await setSetting('loyalty.points_per_currency_unit', 99);
      const p = await admin.promotion.findFirstOrThrow({ where: { businessId: biz.businessId } });
      await request(app.getHttpServer()).patch(`/api/v1/promotions/${p.id}`).set('Authorization', auth()).send({ name: 'Renamed' }).expect(200);
      await request(app.getHttpServer()).delete(`/api/v1/promotions/${p.id}`).set('Authorization', auth()).expect(200);

      const after = await admin.sale.findUniqueOrThrow({ where: { id: saleId }, include: { items: true } });
      expect(after.discountAmount.toString()).toBe(before.discountAmount.toString());
      expect(after.items[0].discountAmount.toString()).toBe(before.items[0].discountAmount.toString());
      expect(after.items[0].unitPrice.toString()).toBe(before.items[0].unitPrice.toString());

      const appsAfter = await admin.salePromotionApplication.findMany({ where: { saleId } });
      expect(appsAfter.map((a) => a.discountApplied.toString())).toEqual(appsBefore.map((a) => a.discountApplied.toString()));
      expect(appsAfter[0].promotionName).toBe(appsBefore[0].promotionName);

      const pointsAfter = await admin.customerPoints.findMany({ where: { referenceId: saleId } });
      expect(pointsAfter.map((e) => `${e.type}:${e.points}:${e.rateSnapshot}`).sort()).toEqual(
        pointsBefore.map((e) => `${e.type}:${e.points}:${e.rateSnapshot}`).sort(),
      );

      await setSetting('loyalty.currency_per_point', 0.01);
      await setSetting('loyalty.points_per_currency_unit', 2);
    });
  });

  // ------------------------------------------------------------------
  describe('Serial capture and the six traceability questions', () => {
    it('answers all six questions after a sale, a warranty and a return', async () => {
      const variantId = await serialVariant('E2E-TRACE', ['TRACE-1', 'TRACE-2']);
      const cust = await customer('Trace');

      const sale = await sell({
        customerId: cust,
        items: [{ variantId, quantity: 2, unitPrice: 100, serials: ['TRACE-1', 'TRACE-2'] }],
        payments: [{ amount: 200 }],
      }).expect(201);
      const saleItemId = sale.body.data.items[0].id;

      const s1 = await admin.serialNumber.findFirstOrThrow({ where: { serial: 'TRACE-1' } });
      const s2 = await admin.serialNumber.findFirstOrThrow({ where: { serial: 'TRACE-2' } });

      await setSetting('warranty.default_duration_days', 365);
      const w = await request(app.getHttpServer())
        .post('/api/v1/warranties')
        .set('Authorization', auth())
        .send({ saleItemId, serialNumberId: s1.id })
        .expect(201);

      // 1. Which serials were sold on this SaleItem?
      const sold = await admin.saleItemSerial.findMany({ where: { saleItemId }, include: { serialNumber: true } });
      expect(sold.map((x) => x.serialNumber.serial).sort()).toEqual(['TRACE-1', 'TRACE-2']);

      // 2. Which SaleItem sold this serial?
      const origin = await admin.saleItemSerial.findFirstOrThrow({ where: { serialNumberId: s1.id } });
      expect(origin.saleItemId).toBe(saleItemId);
      expect(origin.saleId).toBe(sale.body.data.id);

      // Return only TRACE-1.
      const ret = await returnItems(sale.body.data.id, [
        { saleItemId, quantity: 1, condition: 'SELLABLE', serials: ['TRACE-1'] },
      ]).expect(201);

      // 3. Was this exact serial returned? 4. What is its status?
      const back = await admin.saleReturnItemSerial.findMany({ where: { serialNumberId: s1.id } });
      expect(back.length).toBe(1);
      expect(back[0].saleReturnId).toBe(ret.body.data.id);
      expect((await admin.serialNumber.findUniqueOrThrow({ where: { id: s1.id } })).status).toBe('RETURNED');
      // The unit NOT returned is untouched and still SOLD.
      expect((await admin.serialNumber.findUniqueOrThrow({ where: { id: s2.id } })).status).toBe('SOLD');
      expect(await admin.saleReturnItemSerial.findMany({ where: { serialNumberId: s2.id } })).toEqual([]);

      // 5 & 6. The warranty exists and was auto-voided by the return.
      const warranty = await admin.warranty.findUniqueOrThrow({ where: { id: w.body.data.id } });
      expect(warranty.status).toBe('VOID');
      // Never deleted, and its snapshot is intact.
      expect(warranty.durationDays).toBe(365);
      expect(warranty.serialNumberId).toBe(s1.id);
      // The sale link is never deleted either.
      expect(await admin.saleItemSerial.findMany({ where: { serialNumberId: s1.id } })).toHaveLength(1);

      // A claim cannot be registered against the voided warranty.
      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${warranty.id}/claims`)
        .set('Authorization', auth())
        .send({ description: 'too late' })
        .expect(409);
    });

    it('rejects a serial from another variant, a non-existent serial, and a count mismatch', async () => {
      const a = await serialVariant('E2E-REJ-A', ['REJ-A1', 'REJ-A2']);
      await serialVariant('E2E-REJ-B', ['REJ-B1']);

      // Belongs to a different variant.
      await sell({ items: [{ variantId: a, quantity: 1, unitPrice: 10, serials: ['REJ-B1'] }], payments: [{ amount: 10 }] }).expect(422);
      // Does not exist at all.
      await sell({ items: [{ variantId: a, quantity: 1, unitPrice: 10, serials: ['NO-SUCH'] }], payments: [{ amount: 10 }] }).expect(422);
      // Fewer serials than units - caught by the BD-13 count check.
      await sell({ items: [{ variantId: a, quantity: 2, unitPrice: 10, serials: ['REJ-A1'] }], payments: [{ amount: 20 }] }).expect(422);
      // The same unit twice on one line, with enough stock that the
      // duplicate itself is what is rejected rather than the stock bound.
      await sell({ items: [{ variantId: a, quantity: 2, unitPrice: 10, serials: ['REJ-A1', 'REJ-A1'] }], payments: [{ amount: 20 }] }).expect(422);

      // Selling it once works; selling the same unit again is a conflict
      // because it is no longer IN_STOCK.
      await sell({ items: [{ variantId: a, quantity: 1, unitPrice: 10, serials: ['REJ-A1'] }], payments: [{ amount: 10 }] }).expect(201);
      await sell({ items: [{ variantId: a, quantity: 1, unitPrice: 10, serials: ['REJ-A1'] }], payments: [{ amount: 10 }] }).expect(409);
    });

    it('selling more units than there is stock is a stock conflict, checked before serial identity', async () => {
      const v = await serialVariant('E2E-REJ-STOCK', ['STK-1']);
      // Two units requested, one in stock: the InventoryEngine's own
      // negative-stock guard fires first, which is the correct precedence
      // now that serial consumption runs after the stock movement.
      await sell({ items: [{ variantId: v, quantity: 2, unitPrice: 10, serials: ['STK-1', 'STK-1'] }], payments: [{ amount: 20 }] }).expect(409);
    });

    it('a non-serial-tracked line may not carry serials', async () => {
      const variantId = await plainVariant('E2E-NOSERIAL');
      await sell({ items: [{ variantId, quantity: 1, unitPrice: 10, serials: ['X'] }], payments: [{ amount: 10 }] }).expect(422);
    });

    it('a serial cannot be returned twice, nor returned against a line that never sold it', async () => {
      const variantId = await serialVariant('E2E-DBLRET', ['DBL-1']);
      const other = await serialVariant('E2E-DBLRET2', ['DBL-2']);
      const sale = await sell({ items: [{ variantId, quantity: 1, unitPrice: 50, serials: ['DBL-1'] }], payments: [{ amount: 50 }] }).expect(201);
      const saleItemId = sale.body.data.items[0].id;

      await returnItems(sale.body.data.id, [{ saleItemId, quantity: 1, condition: 'SELLABLE', serials: ['DBL-1'] }], undefined, { method: 'CASH', amount: 50 }).expect(201);
      // Second return of the same unit: the quantity bound stops it first,
      // and the serial guard would stop it regardless.
      await returnItems(sale.body.data.id, [{ saleItemId, quantity: 1, condition: 'SELLABLE', serials: ['DBL-1'] }], undefined, { method: 'CASH', amount: 50 }).expect(409);

      const sale2 = await sell({ items: [{ variantId: other, quantity: 1, unitPrice: 50, serials: ['DBL-2'] }], payments: [{ amount: 50 }] }).expect(201);
      await returnItems(sale2.body.data.id, [
        { saleItemId: sale2.body.data.items[0].id, quantity: 1, condition: 'SELLABLE', serials: ['DBL-1'] },
      ]).expect(422);
    });

    it('a serial-tracked return must name its serials, and the count must match', async () => {
      const variantId = await serialVariant('E2E-RETVAL', ['RV-1', 'RV-2']);
      const sale = await sell({
        items: [{ variantId, quantity: 2, unitPrice: 50, serials: ['RV-1', 'RV-2'] }],
        payments: [{ amount: 100 }],
      }).expect(201);
      const saleItemId = sale.body.data.items[0].id;

      await returnItems(sale.body.data.id, [{ saleItemId, quantity: 1, condition: 'SELLABLE' }], undefined, { method: 'CASH', amount: 50 }).expect(422);
      await returnItems(sale.body.data.id, [{ saleItemId, quantity: 2, condition: 'SELLABLE', serials: ['RV-1'] }], undefined, { method: 'CASH', amount: 100 }).expect(422);
      await returnItems(sale.body.data.id, [{ saleItemId, quantity: 1, condition: 'SELLABLE', serials: ['RV-1'] }], undefined, { method: 'CASH', amount: 50 }).expect(201);
    });
  });

  // ------------------------------------------------------------------
  describe('Concurrency (real Promise.all, no mocks)', () => {
    it('two sales attempting the SAME serial: exactly one wins', async () => {
      const variantId = await serialVariant('E2E-CONC-SALE', ['CS-1']);
      const results = await Promise.all([
        sell({ items: [{ variantId, quantity: 1, unitPrice: 100, serials: ['CS-1'] }], payments: [{ amount: 100 }] }),
        sell({ items: [{ variantId, quantity: 1, unitPrice: 100, serials: ['CS-1'] }], payments: [{ amount: 100 }] }),
      ]);
      expect(results.filter((r) => r.status === 201).length).toBe(1);
      expect(results.filter((r) => r.status !== 201).length).toBe(1);

      const serial = await admin.serialNumber.findFirstOrThrow({ where: { serial: 'CS-1' } });
      expect(serial.status).toBe('SOLD');
      // The unit was sold exactly once.
      expect(await admin.saleItemSerial.count({ where: { serialNumberId: serial.id } })).toBe(1);
    });

    it('two returns attempting the SAME serial: exactly one wins', async () => {
      const variantId = await serialVariant('E2E-CONC-RET', ['CR-1', 'CR-2']);
      const sale = await sell({
        items: [{ variantId, quantity: 2, unitPrice: 100, serials: ['CR-1', 'CR-2'] }],
        payments: [{ amount: 200 }],
      }).expect(201);
      const saleItemId = sale.body.data.items[0].id;

      const results = await Promise.all([
        returnItems(sale.body.data.id, [{ saleItemId, quantity: 1, condition: 'SELLABLE', serials: ['CR-1'] }], undefined, { method: 'CASH', amount: 100 }),
        returnItems(sale.body.data.id, [{ saleItemId, quantity: 1, condition: 'SELLABLE', serials: ['CR-1'] }], undefined, { method: 'CASH', amount: 100 }),
      ]);
      expect(results.filter((r) => r.status === 201).length).toBe(1);

      const serial = await admin.serialNumber.findFirstOrThrow({ where: { serial: 'CR-1' } });
      expect(serial.status).toBe('RETURNED');
      expect(await admin.saleReturnItemSerial.count({ where: { serialNumberId: serial.id } })).toBe(1);
    });

    it('a Sale and a Return on the same customer and serials complete with no deadlock', async () => {
      const cust = await customer('Deadlock 8E');
      await grantPoints(cust, 10000);
      const v1 = await serialVariant('E2E-DL-1', ['DL-A']);
      const v2 = await serialVariant('E2E-DL-2', ['DL-B']);

      const sale = await sell({
        customerId: cust,
        items: [{ variantId: v1, quantity: 1, unitPrice: 100, serials: ['DL-A'] }],
        redeemPoints: 1000,
        payments: [{ amount: 90 }],
      }).expect(201);

      const results = await Promise.all([
        returnItems(sale.body.data.id, [
          { saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE', serials: ['DL-A'] },
        ]),
        sell({
          customerId: cust,
          items: [{ variantId: v2, quantity: 1, unitPrice: 100, serials: ['DL-B'] }],
          redeemPoints: 1000,
          payments: [{ amount: 90 }],
        }),
      ]);
      for (const r of results) {
        expect([200, 201, 409, 422]).toContain(r.status);
        expect(JSON.stringify(r.body)).not.toMatch(/deadlock/i);
      }

      const rows: Array<{ customer_id: string }> = await admin.$queryRawUnsafe(
        `SELECT customer_id FROM customer_points GROUP BY customer_id HAVING SUM(points) < 0`,
      );
      expect(rows).toEqual([]);
    });

    it('concurrent warranty registration for one serial produces exactly one warranty', async () => {
      const variantId = await serialVariant('E2E-CONC-WTY', ['CW-1']);
      const sale = await sell({
        items: [{ variantId, quantity: 1, unitPrice: 100, serials: ['CW-1'] }],
        payments: [{ amount: 100 }],
      }).expect(201);
      const saleItemId = sale.body.data.items[0].id;
      const serial = await admin.serialNumber.findFirstOrThrow({ where: { serial: 'CW-1' } });

      const results = await Promise.all([
        request(app.getHttpServer()).post('/api/v1/warranties').set('Authorization', auth()).send({ saleItemId, serialNumberId: serial.id }),
        request(app.getHttpServer()).post('/api/v1/warranties').set('Authorization', auth()).send({ saleItemId, serialNumberId: serial.id }),
      ]);
      expect(results.filter((r) => r.status === 201).length).toBe(1);
      expect(await admin.warranty.count({ where: { saleItemId, serialNumberId: serial.id } })).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  describe('Idempotency across the whole stack', () => {
    it('a replay of a promotion + manual + redemption + serial sale is safe and creates nothing new', async () => {
      const cust = await customer('Idem 8E');
      await grantPoints(cust, 5000);
      const variantId = await serialVariant('E2E-IDEM', ['ID-1']);
      await promo({ name: 'idem 10pct', type: 'PERCENTAGE', percentageValue: 10, targetType: 'VARIANT', targetId: variantId });

      const k = key('sale8e');
      const body = {
        customerId: cust,
        items: [{ variantId, quantity: 1, unitPrice: 200, discountAmount: 10, serials: ['ID-1'] }],
        redeemPoints: 1000,
        payments: [{ amount: 160 }],
        idempotencyKey: k,
      };

      const first = await sell(body).expect(201);
      const replay = await sell(body).expect(201);
      expect(replay.body.data.id).toBe(first.body.data.id);

      expect(await admin.saleItemSerial.count({ where: { saleId: first.body.data.id } })).toBe(1);
      expect(await admin.salePromotionApplication.count({ where: { saleId: first.body.data.id } })).toBe(1);
      expect(await admin.customerPoints.count({ where: { referenceId: first.body.data.id, type: 'REDEEM' } })).toBe(1);
      expect(await admin.customerPoints.count({ where: { referenceId: first.body.data.id, type: 'EARN' } })).toBe(1);
    });

    it('the same key with a different SERIAL is rejected, not silently replayed', async () => {
      const variantId = await serialVariant('E2E-IDEM2', ['IS-1', 'IS-2']);
      const k = key('sale8e2');
      const base = { items: [{ variantId, quantity: 1, unitPrice: 100, serials: ['IS-1'] }], payments: [{ amount: 100 }], idempotencyKey: k };
      await sell(base).expect(201);
      await sell({ ...base, items: [{ variantId, quantity: 1, unitPrice: 100, serials: ['IS-2'] }] }).expect(409);
    });

    it('a return replay with different serials is rejected', async () => {
      const variantId = await serialVariant('E2E-IDEM3', ['IR-1', 'IR-2']);
      const sale = await sell({
        items: [{ variantId, quantity: 2, unitPrice: 100, serials: ['IR-1', 'IR-2'] }],
        payments: [{ amount: 200 }],
      }).expect(201);
      const saleItemId = sale.body.data.items[0].id;
      const k = key('ret8e');

      await returnItems(sale.body.data.id, [{ saleItemId, quantity: 1, condition: 'SELLABLE', serials: ['IR-1'] }], k, { method: 'CASH', amount: 100 }).expect(201);
      // Same key, same shape, DIFFERENT physical unit.
      await returnItems(sale.body.data.id, [{ saleItemId, quantity: 1, condition: 'SELLABLE', serials: ['IR-2'] }], k, { method: 'CASH', amount: 100 }).expect(409);
      // Same key, identical payload -> safe replay.
      const replay = await returnItems(sale.body.data.id, [{ saleItemId, quantity: 1, condition: 'SELLABLE', serials: ['IR-1'] }], k, { method: 'CASH', amount: 100 }).expect(201);
      expect(await admin.saleReturnItemSerial.count({ where: { saleReturnId: replay.body.data.id } })).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  describe('Append-only and tenant isolation for the new links', () => {
    it('the runtime role cannot UPDATE or DELETE either serial link', async () => {
      for (const table of ['sale_item_serials', 'sale_return_item_serials']) {
        const grants: Array<{ privilege_type: string }> = await admin.$queryRawUnsafe(
          `SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='erp_app' AND table_name='${table}' ORDER BY privilege_type`,
        );
        expect(grants.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
      }

      const row = await admin.saleItemSerial.findFirstOrThrow({ where: { businessId: biz.businessId } });
      const runtime = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
      try {
        await expect(
          runtime.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
            return tx.$executeRawUnsafe(`DELETE FROM sale_item_serials WHERE id = '${row.id}'`);
          }),
        ).rejects.toThrow(/permission denied/i);

        // RLS: another tenant sees nothing.
        const rows = await runtime.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '00000000-0000-4000-8000-000000000000'`);
          return tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM sale_item_serials WHERE id = '${row.id}'`);
        });
        expect(rows).toHaveLength(0);
      } finally {
        await runtime.$disconnect();
      }
      expect(await admin.saleItemSerial.findUnique({ where: { id: row.id } })).not.toBeNull();
    });

    it('no serial is ever linked to two different sale lines while SOLD', async () => {
      const rows: Array<{ serial_number_id: string }> = await admin.$queryRawUnsafe(`
        SELECT sis.serial_number_id
          FROM sale_item_serials sis
          JOIN serial_numbers sn ON sn.id = sis.serial_number_id
         WHERE sn.status = 'SOLD'
         GROUP BY sis.serial_number_id
        HAVING count(DISTINCT sis.sale_item_id) > 1
      `);
      expect(rows).toEqual([]);
    });
  });
});
