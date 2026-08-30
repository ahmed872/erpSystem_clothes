import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 8C - loyalty redemption, earning at sale time, return clawback
 * and redeemed-point restoration. Real NestJS app + real PostgreSQL with
 * RLS/FORCE RLS active. No mocks: atomicity, concurrency, tenant
 * isolation and the impossibility of a negative balance are integrity
 * invariants a mock cannot prove.
 */
describe('Loyalty redemption, earning, clawback and restoration (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let other: SalesFixture;

  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
  let seq = 0;
  const nextKey = (p: string) => `${p}-${Date.now()}-${seq++}`;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'loy8c-a');
    other = await setupSalesFixture(app, 'loy8c-b');
    await setRate('loyalty.currency_per_point', 0.01);
    await setRate('loyalty.points_per_currency_unit', 2);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function setRate(key: string, value: unknown, token = auth()) {
    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('Authorization', token)
      .send({ key, value })
      .expect(200);
  }

  async function createCustomer(name: string, token = auth()) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales/customers')
      .set('Authorization', token)
      .send({ name })
      .expect(201);
    return res.body.data.id as string;
  }

  /** Grants points through the Phase 8B manual-adjustment endpoint. */
  async function grantPoints(customerId: string, points: number, token = auth()) {
    await request(app.getHttpServer())
      .post(`/api/v1/sales/customers/${customerId}/points/adjust`)
      .set('Authorization', token)
      .send({ points, reason: 'Test seed', idempotencyKey: nextKey('seed') })
      .expect(201);
  }

  async function balance(customerId: string, token = auth()) {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/sales/customers/${customerId}/points`)
      .set('Authorization', token)
      .expect(200);
    return D(res.body.data.balance);
  }

  /** `rawToken` is the bare access token (createSimpleProduct adds its
   * own `Bearer ` prefix); the direct request below adds one too. */
  async function stockedVariant(sku: string, qty = 500, rawToken = biz.accessToken, fixture = biz) {
    const { variantId } = await createSimpleProduct(app, rawToken, fixture.uomId, sku, { defaultCost: 1 });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', `Bearer ${rawToken}`)
      .send({ warehouseId: fixture.warehouseId, variantId, quantity: qty, unitCost: 1 })
      .expect(201);
    return variantId;
  }

  function sell(body: Record<string, unknown>, token = auth(), fixture = biz) {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', token)
      .send({ warehouseId: fixture.warehouseId, ...body });
  }

  function returnUnits(saleId: string, items: Record<string, unknown>[], token = auth()) {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/returns`)
      .set('Authorization', token)
      .send({ items });
  }

  async function ledger(customerId: string) {
    return admin.customerPoints.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } });
  }

  // ------------------------------------------------------------------
  describe('Redemption calculation, rounding and snapshot', () => {
    it('converts points at the configured rate and folds the value into line discounts', async () => {
      const customerId = await createCustomer('Redeemer');
      await grantPoints(customerId, 5000);
      const variantId = await stockedVariant('LOY-BASIC');

      // 5000 points x 0.01 = 50.00 off a 300.00 basket.
      const res = await sell({
        customerId,
        items: [{ variantId, quantity: 3, unitPrice: 100 }],
        redeemPoints: 5000,
        payments: [{ amount: 250 }],
      }).expect(201);

      const sale = await admin.sale.findUniqueOrThrow({ where: { id: res.body.data.id }, include: { items: true } });
      expect(sale.subtotal.toString()).toBe('300');
      expect(sale.discountAmount.toString()).toBe('50');
      expect(sale.totalAmount.toString()).toBe('250');

      // BD-2's invariant: the sale discount is exactly the sum of line discounts.
      const lineSum = sale.items.reduce((s, i) => s.plus(i.discountAmount), D(0));
      expect(lineSum.toString()).toBe(sale.discountAmount.toString());

      const redeem = (await ledger(customerId)).find((e) => e.type === 'REDEEM')!;
      expect(redeem.points.toString()).toBe('-5000');
      expect(redeem.basisAmount!.toString()).toBe('50');
      expect(redeem.rateSnapshot!.toString()).toBe('0.01');
      expect(redeem.referenceType).toBe('Sale');
      expect(redeem.referenceId).toBe(sale.id);
    });

    it('rounds the redemption value to 4dp HALF-UP', async () => {
      const customerId = await createCustomer('Rounder');
      await grantPoints(customerId, 1000);
      const variantId = await stockedVariant('LOY-ROUND');
      await setRate('loyalty.currency_per_point', 0.000125); // 333 pts -> 0.0416250 -> 0.0416

      const res = await sell({
        customerId,
        items: [{ variantId, quantity: 1, unitPrice: 100 }],
        redeemPoints: 333,
        payments: [{ amount: 99.9584 }],
      }).expect(201);

      const redeem = (await ledger(customerId)).find((e) => e.type === 'REDEEM')!;
      // 333 x 0.000125 = 0.0416250, HALF-UP at 4dp -> 0.0416 (the digit
      // after the cut is 5 but the value is exactly .04162|50 -> .0416 is
      // wrong for half-up, so assert the real computed value).
      expect(redeem.basisAmount!.toString()).toBe('0.0416');
      const sale = await admin.sale.findUniqueOrThrow({ where: { id: res.body.data.id } });
      expect(sale.discountAmount.toString()).toBe('0.0416');
      await setRate('loyalty.currency_per_point', 0.01);
    });

    it('allocates across multiple lines summing exactly to the redemption value, capped per line', async () => {
      const customerId = await createCustomer('Allocator');
      await grantPoints(customerId, 10000);
      const a = await stockedVariant('LOY-ALLOC-A');
      const b = await stockedVariant('LOY-ALLOC-B');
      const c = await stockedVariant('LOY-ALLOC-C');

      // Three lines of 33.33 / 33.33 / 33.34 eligible; redeem 10000 pts = 100.00.
      const res = await sell({
        customerId,
        items: [
          { variantId: a, quantity: 1, unitPrice: 33.33 },
          { variantId: b, quantity: 1, unitPrice: 33.33 },
          { variantId: c, quantity: 1, unitPrice: 33.34 },
        ],
        redeemPoints: 10000,
        payments: [{ amount: 0 }].filter(() => false),
      }).expect(201);

      const sale = await admin.sale.findUniqueOrThrow({ where: { id: res.body.data.id }, include: { items: true } });
      const lineSum = sale.items.reduce((s, i) => s.plus(i.discountAmount), D(0));
      expect(lineSum.toString()).toBe('100');
      expect(sale.discountAmount.toString()).toBe('100');
      expect(sale.totalAmount.toString()).toBe('0');
      // No line exceeds its own eligible merchandise value.
      for (const i of sale.items) {
        expect(i.discountAmount.lessThanOrEqualTo(i.unitPrice.times(i.quantity))).toBe(true);
      }
    });

    it('a later rate change never alters an existing REDEEM row', async () => {
      const customerId = await createCustomer('Snapshot');
      await grantPoints(customerId, 5000);
      const variantId = await stockedVariant('LOY-SNAP');
      const res = await sell({
        customerId,
        items: [{ variantId, quantity: 1, unitPrice: 100 }],
        redeemPoints: 1000,
        payments: [{ amount: 90 }],
      }).expect(201);

      const before = (await ledger(customerId)).find((e) => e.type === 'REDEEM')!;
      await setRate('loyalty.currency_per_point', 5);
      const after = await admin.customerPoints.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.basisAmount!.toString()).toBe('10');
      expect(after.rateSnapshot!.toString()).toBe('0.01');
      const sale = await admin.sale.findUniqueOrThrow({ where: { id: res.body.data.id } });
      expect(sale.discountAmount.toString()).toBe('10');
      await setRate('loyalty.currency_per_point', 0.01);
    });
  });

  // ------------------------------------------------------------------
  describe('Earning after redemption (BD-3)', () => {
    it('earns on the NET merchandise amount after the redemption discount, floored, excluding tax', async () => {
      const customerId = await createCustomer('Earner');
      await grantPoints(customerId, 5000);
      const variantId = await stockedVariant('LOY-EARN');

      // 300 gross - 50 redemption = 250 net; tax 10 is excluded.
      // rate 2 => floor(250 x 2) = 500 points earned.
      const res = await sell({
        customerId,
        items: [{ variantId, quantity: 3, unitPrice: 100, taxAmount: 10 }],
        redeemPoints: 5000,
        payments: [{ amount: 260 }],
      }).expect(201);

      const earn = (await ledger(customerId)).find((e) => e.type === 'EARN' && e.referenceId === res.body.data.id)!;
      expect(earn.points.toString()).toBe('500');
      expect(earn.basisAmount!.toString()).toBe('250');
      expect(earn.rateSnapshot!.toString()).toBe('2');
      // Net effect: -5000 redeemed + 500 earned.
      expect((await balance(customerId)).toString()).toBe('500');
    });

    it('floors rather than rounding up, and records nothing when the result is zero', async () => {
      const customerId = await createCustomer('Floorer');
      const variantId = await stockedVariant('LOY-FLOOR');
      await setRate('loyalty.points_per_currency_unit', 0.5);

      // 99 x 0.5 = 49.5 -> floor 49
      await sell({ customerId, items: [{ variantId, quantity: 1, unitPrice: 99 }], payments: [{ amount: 99 }] }).expect(201);
      expect((await balance(customerId)).toString()).toBe('49');

      // 1 x 0.5 = 0.5 -> floor 0 -> no row at all
      const before = (await ledger(customerId)).length;
      await sell({ customerId, items: [{ variantId, quantity: 1, unitPrice: 1 }], payments: [{ amount: 1 }] }).expect(201);
      expect((await ledger(customerId)).length).toBe(before);
      await setRate('loyalty.points_per_currency_unit', 2);
    });

    it('earns nothing when no earning rate is configured, and the sale still succeeds', async () => {
      const scratch = await setupSalesFixture(app, 'loy8c-norate');
      const customerId = await createCustomer('No Programme', `Bearer ${scratch.accessToken}`);
      const variantId = await stockedVariant('LOY-NORATE', 100, scratch.accessToken, scratch);
      await sell(
        { customerId, items: [{ variantId, quantity: 1, unitPrice: 50 }], payments: [{ amount: 50 }] },
        `Bearer ${scratch.accessToken}`,
        scratch,
      ).expect(201);
      expect((await ledger(customerId)).length).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  describe('Rejections - each rolls the ENTIRE sale back', () => {
    async function assertZeroTrace(fn: () => Promise<unknown>, customerId: string) {
      const before = {
        sales: await admin.sale.count({ where: { businessId: biz.businessId } }),
        movements: await admin.stockMovement.count({ where: { businessId: biz.businessId } }),
        payments: await admin.salePayment.count({ where: { businessId: biz.businessId } }),
        entries: await admin.journalEntry.count({ where: { businessId: biz.businessId } }),
        points: await admin.customerPoints.count({ where: { customerId } }),
        txns: await admin.customerTransaction.count({ where: { customerId } }),
      };
      await fn();
      expect(await admin.sale.count({ where: { businessId: biz.businessId } })).toBe(before.sales);
      expect(await admin.stockMovement.count({ where: { businessId: biz.businessId } })).toBe(before.movements);
      expect(await admin.salePayment.count({ where: { businessId: biz.businessId } })).toBe(before.payments);
      expect(await admin.journalEntry.count({ where: { businessId: biz.businessId } })).toBe(before.entries);
      expect(await admin.customerPoints.count({ where: { customerId } })).toBe(before.points);
      expect(await admin.customerTransaction.count({ where: { customerId } })).toBe(before.txns);
    }

    it('ZERO-VALUE redemption is rejected 422 with zero trace', async () => {
      const customerId = await createCustomer('Zero Value');
      await grantPoints(customerId, 100);
      const variantId = await stockedVariant('LOY-ZERO');
      await setRate('loyalty.currency_per_point', 0.000001); // 1 pt -> 0.000001 -> round4 -> 0.0000

      await assertZeroTrace(async () => {
        const res = await sell({
          customerId,
          items: [{ variantId, quantity: 1, unitPrice: 100 }],
          redeemPoints: 1,
          payments: [{ amount: 100 }],
        }).expect(422);
        expect(JSON.stringify(res.body)).toMatch(/no monetary value/i);
      }, customerId);

      await setRate('loyalty.currency_per_point', 0.01);
    });

    it('insufficient balance is rejected 409 with zero trace', async () => {
      const customerId = await createCustomer('Poor');
      await grantPoints(customerId, 10);
      const variantId = await stockedVariant('LOY-POOR');

      await assertZeroTrace(async () => {
        const res = await sell({
          customerId,
          items: [{ variantId, quantity: 1, unitPrice: 100 }],
          redeemPoints: 5000,
          payments: [{ amount: 50 }],
        }).expect(409);
        expect(JSON.stringify(res.body)).toMatch(/balance/i);
      }, customerId);
    });

    it('redemption with no configured rate is rejected 422 with zero trace', async () => {
      const scratch = await setupSalesFixture(app, 'loy8c-noredeem');
      const token = `Bearer ${scratch.accessToken}`;
      const customerId = await createCustomer('No Rate', token);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${customerId}/points/adjust`)
        .set('Authorization', token)
        .send({ points: 5000, reason: 'seed', idempotencyKey: nextKey('nr') })
        .expect(201);
      const variantId = await stockedVariant('LOY-NORATE-2', 100, scratch.accessToken, scratch);

      const salesBefore = await admin.sale.count({ where: { businessId: scratch.businessId } });
      const res = await sell(
        { customerId, items: [{ variantId, quantity: 1, unitPrice: 100 }], redeemPoints: 100, payments: [{ amount: 99 }] },
        token,
        scratch,
      ).expect(422);
      expect(JSON.stringify(res.body)).toMatch(/not configured/i);
      expect(await admin.sale.count({ where: { businessId: scratch.businessId } })).toBe(salesBefore);
    });

    it('redemption on a walk-in sale is rejected 422', async () => {
      const variantId = await stockedVariant('LOY-WALKIN');
      await sell({ items: [{ variantId, quantity: 1, unitPrice: 100 }], redeemPoints: 100, payments: [{ amount: 99 }] }).expect(422);
    });

    it('redemption exceeding the sale merchandise value is rejected 422 with zero trace', async () => {
      const customerId = await createCustomer('Over Cap');
      await grantPoints(customerId, 100000);
      const variantId = await stockedVariant('LOY-CAP');

      await assertZeroTrace(async () => {
        const res = await sell({
          customerId,
          items: [{ variantId, quantity: 1, unitPrice: 10 }],
          redeemPoints: 100000, // 1000.00 against 10.00 of merchandise
          payments: [],
        }).expect(422);
        expect(JSON.stringify(res.body)).toMatch(/exceeds/i);
      }, customerId);
    });

    it('redemption may take merchandise to exactly zero, and the entry still balances', async () => {
      const customerId = await createCustomer('Full Redeem');
      await grantPoints(customerId, 10000);
      const variantId = await stockedVariant('LOY-FULL');

      const res = await sell({
        customerId,
        items: [{ variantId, quantity: 1, unitPrice: 100, taxAmount: 5 }],
        redeemPoints: 10000, // exactly 100.00
        payments: [{ amount: 5 }], // customer still tenders the tax
      }).expect(201);

      const sale = await admin.sale.findUniqueOrThrow({ where: { id: res.body.data.id } });
      expect(sale.discountAmount.toString()).toBe('100');
      expect(sale.totalAmount.toString()).toBe('5');

      const entry = await admin.journalEntry.findFirstOrThrow({
        where: { sourceType: 'Sale', sourceId: sale.id },
        include: { lines: true },
      });
      const debit = entry.lines.reduce((s, l) => s.plus(l.debit), D(0));
      const credit = entry.lines.reduce((s, l) => s.plus(l.credit), D(0));
      expect(debit.toString()).toBe(credit.toString());
    });
  });

  // ------------------------------------------------------------------
  describe('Concurrency and idempotency', () => {
    it('two concurrent redemptions cannot together overspend the balance', async () => {
      const customerId = await createCustomer('Racer');
      await grantPoints(customerId, 10000); // 100.00 of value
      const v1 = await stockedVariant('LOY-RACE-1');
      const v2 = await stockedVariant('LOY-RACE-2');

      const results = await Promise.all([
        sell({ customerId, items: [{ variantId: v1, quantity: 1, unitPrice: 100 }], redeemPoints: 7000, payments: [{ amount: 30 }] }),
        sell({ customerId, items: [{ variantId: v2, quantity: 1, unitPrice: 100 }], redeemPoints: 7000, payments: [{ amount: 30 }] }),
      ]);
      const ok = results.filter((r) => r.status === 201);
      expect(ok.length).toBe(1);
      expect(results.filter((r) => r.status === 409).length).toBe(1);

      // Balance never goes negative; the winner spent 7000 and earned on 30.
      const bal = await balance(customerId);
      expect(bal.greaterThanOrEqualTo(0)).toBe(true);
      const redeems = (await ledger(customerId)).filter((e) => e.type === 'REDEEM');
      expect(redeems.length).toBe(1);
    });

    it('an idempotent replay creates no second REDEEM or EARN row', async () => {
      const customerId = await createCustomer('Idem');
      await grantPoints(customerId, 5000);
      const variantId = await stockedVariant('LOY-IDEM');
      const key = nextKey('sale');
      const body = {
        customerId,
        items: [{ variantId, quantity: 1, unitPrice: 100 }],
        redeemPoints: 1000,
        payments: [{ amount: 90 }],
        idempotencyKey: key,
      };

      const first = await sell(body).expect(201);
      const replay = await sell(body).expect(201);
      expect(replay.body.data.id).toBe(first.body.data.id);

      const events = (await ledger(customerId)).filter((e) => e.referenceId === first.body.data.id);
      expect(events.filter((e) => e.type === 'REDEEM').length).toBe(1);
      expect(events.filter((e) => e.type === 'EARN').length).toBe(1);
    });

    it('the same key with a DIFFERENT redeemPoints is rejected, not silently replayed', async () => {
      const customerId = await createCustomer('Idem Mismatch');
      await grantPoints(customerId, 5000);
      const variantId = await stockedVariant('LOY-IDEM-2');
      const key = nextKey('sale');
      const body = {
        customerId,
        items: [{ variantId, quantity: 1, unitPrice: 100 }],
        redeemPoints: 1000,
        payments: [{ amount: 90 }],
        idempotencyKey: key,
      };
      await sell(body).expect(201);
      await sell({ ...body, redeemPoints: 2000 }).expect(409);
    });

    it('the database permits at most one EARN and one REDEEM per sale', async () => {
      const sale = await admin.sale.findFirstOrThrow({ where: { businessId: biz.businessId, customerId: { not: null } } });
      const dup = admin.$executeRawUnsafe(
        `INSERT INTO customer_points (id, business_id, customer_id, type, points, reference_type, reference_id)
         VALUES (gen_random_uuid(), '${biz.businessId}', '${sale.customerId}', 'EARN', 1, 'Sale', '${sale.id}')`,
      );
      // Either the row is the first EARN for this sale (no conflict) or the
      // unique index rejects it; run twice so the second must always fail.
      await dup.catch(() => undefined);
      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO customer_points (id, business_id, customer_id, type, points, reference_type, reference_id)
           VALUES (gen_random_uuid(), '${biz.businessId}', '${sale.customerId}', 'EARN', 1, 'Sale', '${sale.id}')`,
        ),
        // Postgres names the conflicting KEY rather than the index, so
        // assert on the column tuple the partial unique index covers.
      ).rejects.toThrow(/business_id, reference_type, reference_id, type/);
    });
  });

  // ------------------------------------------------------------------
  describe('Return clawback and redemption restoration', () => {
    it('a FULL return claws back exactly the points earned and restores exactly the points redeemed', async () => {
      const customerId = await createCustomer('Full Return');
      await grantPoints(customerId, 5000);
      const variantId = await stockedVariant('LOY-FULLRET');

      // 300 gross - 50 redeemed = 250 net; earns floor(250 x 2) = 500.
      const sale = await sell({
        customerId,
        items: [{ variantId, quantity: 3, unitPrice: 100 }],
        redeemPoints: 5000,
        payments: [{ amount: 250 }],
      }).expect(201);
      const saleItemId = sale.body.data.items[0].id;
      expect((await balance(customerId)).toString()).toBe('500');

      await returnUnits(sale.body.data.id, [{ saleItemId, quantity: 3, condition: 'SELLABLE' }]).expect(201);

      const events = await ledger(customerId);
      const clawback = events.filter((e) => e.type === 'RETURN_CLAWBACK').reduce((s, e) => s.plus(e.points), D(0));
      const restored = events.filter((e) => e.type === 'REDEMPTION_RESTORATION').reduce((s, e) => s.plus(e.points), D(0));
      expect(clawback.toString()).toBe('-500');
      expect(restored.toString()).toBe('5000');
      // Back to the original grant: 5000 - 5000 + 500 - 500 + 5000 = 5000
      expect((await balance(customerId)).toString()).toBe('5000');
    });

    it('SEQUENTIAL partial returns cumulatively claw back and restore EXACTLY the originals', async () => {
      const customerId = await createCustomer('Partial Return');
      await grantPoints(customerId, 5000);
      const variantId = await stockedVariant('LOY-PARTRET');

      const sale = await sell({
        customerId,
        items: [{ variantId, quantity: 3, unitPrice: 100 }],
        redeemPoints: 5000,
        payments: [{ amount: 250 }],
      }).expect(201);
      const saleItemId = sale.body.data.items[0].id;

      const clawSteps: string[] = [];
      const restoreSteps: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await returnUnits(sale.body.data.id, [{ saleItemId, quantity: 1, condition: 'SELLABLE' }]).expect(201);
        const rows = await admin.customerPoints.findMany({ where: { referenceType: 'SaleReturn', referenceId: r.body.data.id } });
        clawSteps.push((rows.find((x) => x.type === 'RETURN_CLAWBACK')?.points ?? D(0)).toString());
        restoreSteps.push((rows.find((x) => x.type === 'REDEMPTION_RESTORATION')?.points ?? D(0)).toString());
      }

      // The exact cumulative-delta sequence from the approved design.
      expect(clawSteps).toEqual(['-167', '-167', '-166']);
      expect(restoreSteps).toEqual(['1666.666', '1666.668', '1666.666']);

      const events = await ledger(customerId);
      const clawTotal = events.filter((e) => e.type === 'RETURN_CLAWBACK').reduce((s, e) => s.plus(e.points), D(0));
      const restoreTotal = events.filter((e) => e.type === 'REDEMPTION_RESTORATION').reduce((s, e) => s.plus(e.points), D(0));
      expect(clawTotal.toString()).toBe('-500');
      expect(restoreTotal.toString()).toBe('5000');
      expect((await balance(customerId)).toString()).toBe('5000');
    });

    it('never mutates or deletes the original EARN and REDEEM rows', async () => {
      const customerId = await createCustomer('History');
      await grantPoints(customerId, 5000);
      const variantId = await stockedVariant('LOY-HIST');
      const sale = await sell({
        customerId,
        items: [{ variantId, quantity: 2, unitPrice: 100 }],
        redeemPoints: 5000,
        payments: [{ amount: 150 }],
      }).expect(201);

      const before = (await ledger(customerId)).filter((e) => e.referenceType === 'Sale');
      await returnUnits(sale.body.data.id, [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }]).expect(201);

      for (const row of before) {
        const after = await admin.customerPoints.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.points.toString()).toBe(row.points.toString());
        expect(after.basisAmount!.toString()).toBe(row.basisAmount!.toString());
        expect(after.rateSnapshot!.toString()).toBe(row.rateSnapshot!.toString());
        expect(after.createdAt.getTime()).toBe(row.createdAt.getTime());
      }
    });

    it('uses the ORIGINAL rate snapshots even after the business rates change', async () => {
      const customerId = await createCustomer('Rate Change');
      await grantPoints(customerId, 5000);
      const variantId = await stockedVariant('LOY-RATECHANGE');
      const sale = await sell({
        customerId,
        items: [{ variantId, quantity: 3, unitPrice: 100 }],
        redeemPoints: 5000,
        payments: [{ amount: 250 }],
      }).expect(201);

      // Change BOTH rates dramatically before returning.
      await setRate('loyalty.points_per_currency_unit', 50);
      await setRate('loyalty.currency_per_point', 9);

      await returnUnits(sale.body.data.id, [{ saleItemId: sale.body.data.items[0].id, quantity: 3, condition: 'SELLABLE' }]).expect(201);

      const events = await ledger(customerId);
      const claw = events.find((e) => e.type === 'RETURN_CLAWBACK')!;
      const restore = events.find((e) => e.type === 'REDEMPTION_RESTORATION')!;
      // Computed from the ORIGINAL 2 and 0.01, not from 50 and 9.
      expect(claw.points.toString()).toBe('-500');
      expect(claw.rateSnapshot!.toString()).toBe('2');
      expect(restore.points.toString()).toBe('5000');
      expect(restore.rateSnapshot!.toString()).toBe('0.01');

      await setRate('loyalty.points_per_currency_unit', 2);
      await setRate('loyalty.currency_per_point', 0.01);
    });

    it('rejects the ENTIRE return when the clawback would drive the balance negative', async () => {
      const customerId = await createCustomer('Spent It');
      const variantId = await stockedVariant('LOY-NEG-1');
      const spendVariant = await stockedVariant('LOY-NEG-2');

      // Earn 500 on a 250 sale with no redemption, so there is nothing to restore.
      const sale = await sell({
        customerId,
        items: [{ variantId, quantity: 1, unitPrice: 250 }],
        payments: [{ amount: 250 }],
      }).expect(201);
      expect((await balance(customerId)).toString()).toBe('500');

      // Spend the points on a second sale.
      await sell({
        customerId,
        items: [{ variantId: spendVariant, quantity: 1, unitPrice: 100 }],
        redeemPoints: 500,
        payments: [{ amount: 95 }],
      }).expect(201);

      const before = {
        returns: await admin.saleReturn.count({ where: { saleId: sale.body.data.id } }),
        movements: await admin.stockMovement.count({ where: { businessId: biz.businessId } }),
        entries: await admin.journalEntry.count({ where: { businessId: biz.businessId } }),
        points: (await ledger(customerId)).length,
        returned: (await admin.saleItem.findUniqueOrThrow({ where: { id: sale.body.data.items[0].id } })).quantityReturned.toString(),
      };

      const res = await returnUnits(sale.body.data.id, [
        { saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' },
      ]).expect(409);
      expect(JSON.stringify(res.body)).toMatch(/negative balance/i);

      // The WHOLE return rolled back - no refund, no movement, no entry, no row.
      expect(await admin.saleReturn.count({ where: { saleId: sale.body.data.id } })).toBe(before.returns);
      expect(await admin.stockMovement.count({ where: { businessId: biz.businessId } })).toBe(before.movements);
      expect(await admin.journalEntry.count({ where: { businessId: biz.businessId } })).toBe(before.entries);
      expect((await ledger(customerId)).length).toBe(before.points);
      expect(
        (await admin.saleItem.findUniqueOrThrow({ where: { id: sale.body.data.items[0].id } })).quantityReturned.toString(),
      ).toBe(before.returned);
    });

    it('a return whose own restoration funds its clawback is allowed', async () => {
      const customerId = await createCustomer('Self Funded');
      await grantPoints(customerId, 5000);
      const variantId = await stockedVariant('LOY-SELFFUND');
      const sale = await sell({
        customerId,
        items: [{ variantId, quantity: 3, unitPrice: 100 }],
        redeemPoints: 5000,
        payments: [{ amount: 250 }],
      }).expect(201);

      // Spend down to almost nothing so the clawback alone would go
      // negative - the restoration is what makes the return affordable.
      const other2 = await stockedVariant('LOY-SELFFUND-2');
      await sell({
        customerId,
        items: [{ variantId: other2, quantity: 1, unitPrice: 100 }],
        redeemPoints: 500,
        payments: [{ amount: 95 }],
      }).expect(201);

      await returnUnits(sale.body.data.id, [{ saleItemId: sale.body.data.items[0].id, quantity: 3, condition: 'SELLABLE' }]).expect(201);
      expect((await balance(customerId)).greaterThanOrEqualTo(0)).toBe(true);
    });

    it('a sale-vs-return race on the same customer completes without deadlock', async () => {
      const customerId = await createCustomer('Deadlock');
      await grantPoints(customerId, 20000);
      const v1 = await stockedVariant('LOY-DL-1');
      const v2 = await stockedVariant('LOY-DL-2');

      const sale = await sell({
        customerId,
        items: [{ variantId: v1, quantity: 2, unitPrice: 100 }],
        redeemPoints: 1000,
        payments: [{ amount: 190 }],
      }).expect(201);

      const results = await Promise.all([
        returnUnits(sale.body.data.id, [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }]),
        sell({ customerId, items: [{ variantId: v2, quantity: 1, unitPrice: 100 }], redeemPoints: 1000, payments: [{ amount: 90 }] }),
      ]);
      for (const r of results) {
        expect([200, 201, 409]).toContain(r.status);
        expect(JSON.stringify(r.body)).not.toMatch(/deadlock/i);
      }
      expect((await balance(customerId)).greaterThanOrEqualTo(0)).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  describe('Accounting is untouched by loyalty', () => {
    it('no loyalty account, mapping or journal line is ever created', async () => {
      const loyaltyAccounts = await admin.account.findMany({
        where: { businessId: biz.businessId, OR: [{ name: { contains: 'oyalt' } }, { code: { contains: 'LOYAL' } }] },
      });
      expect(loyaltyAccounts).toEqual([]);

      const loyaltyLines = await admin.journalEntryLine.findMany({
        where: { businessId: biz.businessId, description: { contains: 'oyalt' } },
      });
      expect(loyaltyLines).toEqual([]);
    });

    it('a redeemed sale posts revenue NET of the redemption, and balances', async () => {
      const customerId = await createCustomer('GL Check');
      await grantPoints(customerId, 5000);
      const variantId = await stockedVariant('LOY-GL');
      const sale = await sell({
        customerId,
        items: [{ variantId, quantity: 3, unitPrice: 100 }],
        redeemPoints: 5000,
        payments: [{ amount: 250 }],
      }).expect(201);

      const entry = await admin.journalEntry.findFirstOrThrow({
        where: { sourceType: 'Sale', sourceId: sale.body.data.id },
        include: { lines: { include: { account: true } } },
      });
      const revenue = entry.lines.find((l) => l.account.name.toLowerCase().includes('revenue'))!;
      expect(revenue.credit.toString()).toBe('250');

      const debit = entry.lines.reduce((s, l) => s.plus(l.debit), D(0));
      const credit = entry.lines.reduce((s, l) => s.plus(l.credit), D(0));
      expect(debit.toString()).toBe(credit.toString());
    });
  });

  // ------------------------------------------------------------------
  describe('Tenant isolation and permissions', () => {
    it("a sale in business B cannot redeem business A's customer points", async () => {
      const customerA = await createCustomer('Tenant A Cust');
      await grantPoints(customerA, 5000);
      const variantB = await stockedVariant('LOY-TENANT-B', 100, other.accessToken, other);

      await sell(
        { customerId: customerA, items: [{ variantId: variantB, quantity: 1, unitPrice: 100 }], redeemPoints: 1000, payments: [{ amount: 90 }] },
        `Bearer ${other.accessToken}`,
        other,
      ).expect(404);

      expect((await balance(customerA)).toString()).toBe('5000');
    });

    it('a CASHIER can redeem at the till through sales.create, with no extra permission', async () => {
      const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'CASHIER' } });
      const email = `loycashier@${biz.slug}.test`;
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'loycashier', email, password: 'RoleUserPass1!', roleIds: [role.id], branchIds: [] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'RoleUserPass1!', businessSlug: biz.slug })
        .expect(200);
      const token = `Bearer ${login.body.data.accessToken}`;

      await request(app.getHttpServer())
        .post('/api/v1/sales/shifts/open')
        .set('Authorization', token)
        .send({ warehouseId: biz.warehouseId })
        .expect(201);

      const customerId = await createCustomer('Till Customer');
      await grantPoints(customerId, 5000);
      const variantId = await stockedVariant('LOY-TILL');

      await sell(
        { customerId, items: [{ variantId, quantity: 1, unitPrice: 100 }], redeemPoints: 1000, payments: [{ amount: 90 }] },
        token,
      ).expect(201);

      // ...but still cannot hand out points by hand (Phase 8B boundary).
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${customerId}/points/adjust`)
        .set('Authorization', token)
        .send({ points: 100, reason: 'nope', idempotencyKey: nextKey('c') })
        .expect(403);
    });

    it('no customer anywhere ends with a negative derived balance', async () => {
      const rows: Array<{ customer_id: string }> = await admin.$queryRawUnsafe(
        `SELECT customer_id FROM customer_points GROUP BY customer_id HAVING SUM(points) < 0`,
      );
      expect(rows).toEqual([]);
    });
  });
});
