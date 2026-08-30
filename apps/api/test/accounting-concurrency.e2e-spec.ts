import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

describe('Accounting: concurrency, idempotency, and period controls (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'acct-concurrency');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  it('DUPLICATE POSTING: two truly simultaneous sale requests with the SAME idempotencyKey never both post a JournalEntry - exactly one', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ACCT-CONC-1');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 5 })
      .expect(201);

    const idempotencyKey = randomUUID();
    const body = { warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 10 }], payments: [{ amount: 10 }], idempotencyKey };

    const results = await Promise.all([
      request(app.getHttpServer()).post('/api/v1/sales').set('Authorization', auth()).send(body),
      request(app.getHttpServer()).post('/api/v1/sales').set('Authorization', auth()).send(body),
    ]);
    // Two interleavings are BOTH correct here, and which one occurs is a
    // genuine race the test must not pin down:
    //   (a) both requests start before either commits - the idempotency
    //       pre-check sees nothing, both attempt the INSERT, and the DB's
    //       unique constraint lets exactly one through (1x201 + 1 failure);
    //   (b) the second request's pre-check runs after the first commits -
    //       it finds the existing Sale and returns it as an idempotent
    //       replay (2x201, the SAME sale id).
    // Asserting a specific status split made this test flaky: it was
    // observed failing roughly one run in three on the pre-Phase-8C code
    // as well, so the flakiness is inherent to the assertion, not to any
    // implementation change.
    //
    // What must hold in BOTH interleavings is the actual invariant this
    // test exists for, and it is asserted unconditionally below: exactly
    // ONE Sale carries the key, every 201 refers to that same Sale (a
    // second 201 with a DIFFERENT id would be a real duplicate-creation
    // bug, not a replay), and exactly ONE JournalEntry was posted.
    const succeeded = results.filter((r) => r.status === 201);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    const salesWithKey = await admin.sale.findMany({ where: { businessId: biz.businessId, idempotencyKey } });
    expect(salesWithKey.length).toBe(1);

    const saleId = salesWithKey[0].id;
    for (const r of succeeded) {
      expect(r.body.data.id).toBe(saleId);
    }

    const entries = await admin.journalEntry.findMany({ where: { businessId: biz.businessId, sourceType: 'Sale', sourceId: saleId } });
    expect(entries.length).toBe(1);
  });

  it('CLOSED-PERIOD REJECTION + AUTHORIZED REOPEN: closing the only open period blocks the next Sale from posting; reopening (accounting.reopen_period) restores it', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ACCT-CONC-2');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 5 })
      .expect(201);

    const openPeriod = await admin.fiscalPeriod.findFirstOrThrow({ where: { businessId: biz.businessId, status: 'OPEN' } });
    await request(app.getHttpServer()).post(`/api/v1/accounting/periods/${openPeriod.id}/close`).set('Authorization', auth()).expect(200);

    const saleCountBefore = await admin.sale.count({ where: { businessId: biz.businessId } });
    const blocked = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 10 }], payments: [{ amount: 10 }] });
    // The Sale itself rolls back too - postEntry's closed-period rejection
    // happens inside the SAME transaction as the Sale insert (Phase 0
    // §10 rule #2: one atomic transaction, all or nothing).
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    const saleCountAfterBlocked = await admin.sale.count({ where: { businessId: biz.businessId } });
    expect(saleCountAfterBlocked).toBe(saleCountBefore);

    await request(app.getHttpServer()).post(`/api/v1/accounting/periods/${openPeriod.id}/reopen`).set('Authorization', auth()).expect(200);

    const allowed = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 10 }], payments: [{ amount: 10 }] })
      .expect(201);
    const entries = await admin.journalEntry.findMany({ where: { businessId: biz.businessId, sourceType: 'Sale', sourceId: allowed.body.data.id } });
    expect(entries.length).toBe(1);
  });

  it('PERIOD-CLOSE vs POSTING CONCURRENCY: a concurrent Sale and a period-close never leave an inconsistent state - the Sale either fully succeeds (with its JournalEntry correctly posted) or fully fails (no Sale, no JournalEntry), never a partial/orphaned result', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ACCT-CONC-3');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 5 })
      .expect(201);

    // Ensure there IS an open period to race against (prior test left one
    // open, but be explicit/self-contained).
    const existingOpen = await admin.fiscalPeriod.findFirst({ where: { businessId: biz.businessId, status: 'OPEN' } });
    if (!existingOpen) {
      await request(app.getHttpServer()).post(`/api/v1/accounting/periods`).set('Authorization', auth()).send({ name: 'Race Period', startDate: new Date().toISOString(), endDate: '9999-12-31' }).expect(201);
    }
    const period = await admin.fiscalPeriod.findFirstOrThrow({ where: { businessId: biz.businessId, status: 'OPEN' } });
    // Delta, not absolute - this shared business fixture already has
    // Sale rows from earlier tests in this file (the exact "before/after
    // delta, not an absolute count" discipline the Phase 4/5 reviews
    // already established, repeated here for the same reason).
    const saleCountBefore = await admin.sale.count({ where: { businessId: biz.businessId } });

    const [saleResult, closeResult] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 10 }], payments: [{ amount: 10 }] }),
      request(app.getHttpServer()).post(`/api/v1/accounting/periods/${period.id}/close`).set('Authorization', auth()),
    ]);
    const saleCountAfter = await admin.sale.count({ where: { businessId: biz.businessId } });

    if (saleResult.status === 201) {
      expect(saleCountAfter).toBe(saleCountBefore + 1);
      const entries = await admin.journalEntry.findMany({ where: { businessId: biz.businessId, sourceType: 'Sale', sourceId: saleResult.body.data.id } });
      expect(entries.length).toBe(1);
      expect(entries[0].fiscalPeriodId).toBe(period.id);
    } else {
      // The Sale failed - it must not have left ANY trace (fully rolled
      // back, including inventory/payment/ledger effects, not just the
      // accounting posting) - proven by the delta being exactly zero,
      // not by an absolute count that earlier tests would have polluted.
      expect(saleCountAfter).toBe(saleCountBefore);
    }
    // Whichever won the race, the period ends up CLOSED (closeResult
    // itself always succeeds - closing doesn't depend on whether a sale
    // was mid-flight, only serializes WHEN it takes effect relative to it).
    expect(closeResult.status).toBe(200);
    const finalPeriod = await admin.fiscalPeriod.findUniqueOrThrow({ where: { id: period.id } });
    expect(finalPeriod.status).toBe('CLOSED');

    // Cleanup: reopen so any later test file sharing this fixture isn't
    // left with zero open periods.
    await request(app.getHttpServer()).post(`/api/v1/accounting/periods/${period.id}/reopen`).set('Authorization', auth()).expect(200);
  });
});
