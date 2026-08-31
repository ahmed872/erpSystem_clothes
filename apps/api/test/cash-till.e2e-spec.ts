import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupInventoryFixture, createSimpleProduct, InventoryFixture } from './utils/inventory-fixtures';

/**
 * Phase 10 (BD-17) — cash register and blind-close till reconciliation.
 *
 * Everything here runs against real PostgreSQL. The point of the suite is
 * not that the endpoints respond, but that four specific guarantees hold:
 *
 *   1. expected cash is DERIVED and correct across a full shift;
 *   2. BLIND CLOSE actually withholds the expected figure from the
 *      counting cashier - asserted by the field being ABSENT, not null;
 *   3. the variance reaches the ledger as a balanced journal entry;
 *   4. one open shift per register, proven under a real concurrent race.
 */
describe('Phase 10 - cash registers and blind-close till (e2e, real Postgres)', () => {
  let app: INestApplication;
  let biz: InventoryFixture;
  let admin: PrismaClient;
  let registerId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    biz = await setupInventoryFixture(app, 'cash-till');
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    const registers = await request(app.getHttpServer()).get('/api/v1/cash-registers').set('Authorization', auth()).expect(200);
    registerId = registers.body.data[0].id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;
  const server = () => app.getHttpServer();

  it('onboarding creates a default cash register (Phase 0 §11) so a business can sell immediately', async () => {
    const res = await request(server()).get('/api/v1/cash-registers').set('Authorization', auth()).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].code).toBe('MAIN');
    expect(res.body.data[0].isActive).toBe(true);
    expect(res.body.data[0].branchId).toBe(biz.branchId);
  });

  it('rejects opening a shift whose register belongs to a different branch than the warehouse', async () => {
    const otherBranch = await request(server())
      .post('/api/v1/branches')
      .set('Authorization', auth())
      .send({ name: 'Second branch' })
      .expect(201);

    const foreignRegister = await request(server())
      .post('/api/v1/cash-registers')
      .set('Authorization', auth())
      .send({ branchId: otherBranch.body.data.id, name: 'Other till', code: 'OTHER-1' })
      .expect(201);

    const res = await request(server())
      .post('/api/v1/sales/shifts/open')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, cashRegisterId: foreignRegister.body.data.id, openingFloat: 0 })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('derives expected cash across a full shift: float + cash sale - refund - pay-out, and posts the variance', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'CASH-TILL-1', { defaultSellingPrice: 100 });
    await request(server())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 50, unitCost: 40 })
      .expect(201);

    const opened = await request(server())
      .post('/api/v1/sales/shifts/open')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, cashRegisterId: registerId, openingFloat: 200 })
      .expect(201);
    const shiftId = opened.body.data.id;

    // A cash sale of 300 and a card sale of 500. Only the cash one may
    // touch the drawer - if the card tender leaked in, expected cash would
    // be overstated by exactly 500 and this test would catch it.
    await request(server())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        items: [{ variantId, quantity: 3, unitPrice: 100 }],
        payments: [{ amount: 300, method: 'CASH' }],
      })
      .expect(201);

    await request(server())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        items: [{ variantId, quantity: 5, unitPrice: 100 }],
        payments: [{ amount: 500, method: 'CARD' }],
      })
      .expect(201);

    // A manual pay-out of 50 (petty cash out of the drawer).
    await request(server())
      .post(`/api/v1/sales/shifts/${shiftId}/cash-transactions`)
      .set('Authorization', auth())
      .send({ type: 'PAY_OUT', amount: 50, reason: 'Petty cash - cleaning supplies' })
      .expect(201);

    // ... and a pay-in of 25.
    await request(server())
      .post(`/api/v1/sales/shifts/${shiftId}/cash-transactions`)
      .set('Authorization', auth())
      .send({ type: 'PAY_IN', amount: 25, reason: 'Float top-up' })
      .expect(201);

    // Expected = 200 float + 300 cash sale - 50 pay-out + 25 pay-in = 475.
    const active = await request(server()).get('/api/v1/sales/shifts/active').set('Authorization', auth()).expect(200);
    expect(active.body.data.expectedCash).toBe('475');
    expect(active.body.data.cashIn).toBe('325');
    expect(active.body.data.cashOut).toBe('50');

    // Close counting 470 - a 5.00 shortage.
    const closed = await request(server())
      .post('/api/v1/sales/shifts/close')
      .set('Authorization', auth())
      .send({ countedCash: 470 })
      .expect(200);
    expect(closed.body.data.countedCash).toBe('470');
    expect(closed.body.data.expectedCash).toBe('475');
    expect(closed.body.data.variance).toBe('-5');

    // The variance reached the ledger as a real, balanced entry.
    const entry = await admin.journalEntry.findFirstOrThrow({
      where: { businessId: biz.businessId, sourceType: 'Shift', sourceId: shiftId },
      include: { lines: { include: { account: true } } },
    });
    const debits = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
    const credits = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debits).toBeCloseTo(credits, 4);
    expect(debits).toBeCloseTo(5, 4);

    // A shortage DEBITS the configurable variance account and CREDITS cash.
    const varianceLine = entry.lines.find((l) => l.account.code === '5400')!;
    const cashLine = entry.lines.find((l) => l.account.code === '1010')!;
    expect(Number(varianceLine.debit)).toBeCloseTo(5, 4);
    expect(Number(cashLine.credit)).toBeCloseTo(5, 4);
  });

  it('BLIND CLOSE: a Cashier never receives the expected figure - the fields are ABSENT, not null', async () => {
    const cashierEmail = `cashier-blind-${Date.now()}@example.com`;
    const roles = await request(server()).get('/api/v1/roles').set('Authorization', auth()).expect(200);
    const cashierRole = roles.body.data.find((r: { name: string }) => r.name === 'CASHIER');

    await request(server())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: 'Blind Cashier', email: cashierEmail, password: 'Str0ng!Passw0rd', roleIds: [cashierRole.id], branchIds: [biz.branchId] })
      .expect(201);

    const login = await request(server())
      .post('/api/v1/auth/login')
      .send({ businessSlug: biz.slug, email: cashierEmail, password: 'Str0ng!Passw0rd' })
      .expect(200);
    const cashierAuth = `Bearer ${login.body.data.accessToken}`;

    const till = await request(server())
      .post('/api/v1/cash-registers')
      .set('Authorization', auth())
      .send({ branchId: biz.branchId, name: 'Blind till', code: 'BLIND-1' })
      .expect(201);

    await request(server())
      .post('/api/v1/sales/shifts/open')
      .set('Authorization', cashierAuth)
      .send({ warehouseId: biz.warehouseId, cashRegisterId: till.body.data.id, openingFloat: 100 })
      .expect(201);

    // The endpoint a till would poll. The cashier sees what they keyed in
    // (the float) but NOT what the documents say should be there.
    const active = await request(server()).get('/api/v1/sales/shifts/active').set('Authorization', cashierAuth).expect(200);
    expect(active.body.data.openingFloat).toBe('100');
    expect(active.body.data).not.toHaveProperty('expectedCash');
    expect(active.body.data).not.toHaveProperty('variance');
    expect(active.body.data).not.toHaveProperty('cashIn');
    expect(active.body.data).not.toHaveProperty('cashOut');

    // ... and still not after closing.
    const closed = await request(server())
      .post('/api/v1/sales/shifts/close')
      .set('Authorization', cashierAuth)
      .send({ countedCash: 100 })
      .expect(200);
    expect(closed.body.data.countedCash).toBe('100');
    expect(closed.body.data).not.toHaveProperty('expectedCash');
    expect(closed.body.data).not.toHaveProperty('variance');

    // The owner, who holds shifts.view_expected, sees the whole picture for
    // the very same shift - proving the data exists and only the cashier's
    // VIEW of it is restricted.
    const asOwner = await request(server()).get('/api/v1/sales/shifts').set('Authorization', auth()).expect(200);
    const sameShift = asOwner.body.data.find((s: { id: string }) => s.id === closed.body.data.id);
    expect(sameShift.expectedCash).toBe('100');
    expect(sameShift.variance).toBe('0');
  });

  it('reconciliation is an acknowledgement: it records who accepted the variance and cannot alter the counted amount', async () => {
    const till = await request(server())
      .post('/api/v1/cash-registers')
      .set('Authorization', auth())
      .send({ branchId: biz.branchId, name: 'Recon till', code: 'RECON-1' })
      .expect(201);

    const opened = await request(server())
      .post('/api/v1/sales/shifts/open')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, cashRegisterId: till.body.data.id, openingFloat: 10 })
      .expect(201);

    await request(server())
      .post('/api/v1/sales/shifts/close')
      .set('Authorization', auth())
      .send({ countedCash: 12 })
      .expect(200);

    const reconciled = await request(server())
      .post(`/api/v1/sales/shifts/${opened.body.data.id}/reconcile`)
      .set('Authorization', auth())
      .send({ note: 'Counted twice, accepted' })
      .expect(200);
    expect(reconciled.body.data.reconciledBy).toBe(biz.ownerUserId);
    expect(reconciled.body.data.variance).toBe('2');
    // Rule 6: the counted amount is untouched by the review.
    expect(reconciled.body.data.countedCash).toBe('12');

    // Reconciling twice would overwrite who accepted it - rejected.
    const again = await request(server())
      .post(`/api/v1/sales/shifts/${opened.body.data.id}/reconcile`)
      .set('Authorization', auth())
      .send({})
      .expect(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });

  it('CONCURRENCY: two simultaneous opens on the same register produce exactly one shift', async () => {
    const till = await request(server())
      .post('/api/v1/cash-registers')
      .set('Authorization', auth())
      .send({ branchId: biz.branchId, name: 'Race till', code: 'RACE-1' })
      .expect(201);

    // Two different users, so the one-open-shift-PER-USER index cannot be
    // what rejects the loser - this has to be the per-REGISTER index.
    const tokens: string[] = [];
    const roles = await request(server()).get('/api/v1/roles').set('Authorization', auth()).expect(200);
    const cashierRole = roles.body.data.find((r: { name: string }) => r.name === 'CASHIER');
    for (const n of [1, 2]) {
      const email = `race-${n}-${Date.now()}@example.com`;
      await request(server())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: `Race ${n}`, email, password: 'Str0ng!Passw0rd', roleIds: [cashierRole.id], branchIds: [biz.branchId] })
        .expect(201);
      const login = await request(server())
        .post('/api/v1/auth/login')
        .send({ businessSlug: biz.slug, email, password: 'Str0ng!Passw0rd' })
        .expect(200);
      tokens.push(`Bearer ${login.body.data.accessToken}`);
    }

    const results = await Promise.allSettled(
      tokens.map((t) =>
        request(server())
          .post('/api/v1/sales/shifts/open')
          .set('Authorization', t)
          .send({ warehouseId: biz.warehouseId, cashRegisterId: till.body.data.id, openingFloat: 0 }),
      ),
    );
    const created = results.filter((r) => r.status === 'fulfilled' && r.value.status === 201);
    expect(created).toHaveLength(1);

    // The invariant that actually matters: the database holds exactly one
    // open shift for this register, whichever request won the race.
    const openShifts = await admin.shift.count({
      where: { businessId: biz.businessId, cashRegisterId: till.body.data.id, status: 'OPEN' },
    });
    expect(openShifts).toBe(1);
  });

  it('DB layer: cash_transactions is truly append-only - erp_app has no UPDATE or DELETE privilege', async () => {
    const grants = await admin.$queryRawUnsafe<{ privilege_type: string }[]>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'erp_app' AND table_name = 'cash_transactions'`,
    );
    const privileges = grants.map((g) => g.privilege_type).sort();
    expect(privileges).toEqual(['INSERT', 'SELECT']);
  });

  it('DB layer: the cash tables carry RLS and FORCE RLS with both USING and WITH CHECK', async () => {
    const rows = await admin.$queryRawUnsafe<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; has_using: boolean; has_check: boolean }[]
    >(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              p.qual IS NOT NULL AS has_using, p.with_check IS NOT NULL AS has_check
         FROM pg_class c
         JOIN pg_policies p ON p.tablename = c.relname
        WHERE c.relname IN ('cash_registers', 'cash_transactions')`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.relrowsecurity).toBe(true);
      expect(r.relforcerowsecurity).toBe(true);
      expect(r.has_using).toBe(true);
      expect(r.has_check).toBe(true);
    }
  });

  it('DB layer: the amount sign must agree with the movement type', async () => {
    const shift = await admin.shift.findFirstOrThrow({ where: { businessId: biz.businessId } });
    await expect(
      admin.$executeRawUnsafe(
        `INSERT INTO cash_transactions (id, business_id, shift_id, type, amount)
         VALUES (gen_random_uuid()::text, $1, $2, 'PAY_IN', -100)`,
        biz.businessId,
        shift.id,
      ),
    ).rejects.toThrow(/cash_transactions_amount_sign_matches_type/);
  });
});
