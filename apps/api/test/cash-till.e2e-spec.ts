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
  // ==================================================================
  // Phase 12 (Cash Drawer milestone) — the claims the POS cash workflow
  // rests on that the Phase 10 suite did not yet pin down.
  //
  // The through-line: ONLY PHYSICAL CASH REACHES THE DRAWER. A card sale, a
  // card refund and the server's own EXCHANGE_CREDIT are all real financial
  // events that must leave `cash_transactions` completely alone, because
  // expected cash is derived from that table and a single stray row makes
  // an honest cashier answer for a shortage that never existed.
  // ==================================================================
  describe('Only physical cash reaches the drawer', () => {
    let seq = 0;

    async function stocked(price = 100) {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `DRAWER-${seq++}`, {
        defaultSellingPrice: price,
        defaultCost: 40,
      });
      await request(server())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 50, unitCost: 40 })
        .expect(201);
      return variantId;
    }

    /** A fresh till and a shift on it, so each case owns its own drawer and
     *  the assertions are about that drawer alone. */
    async function freshShift(openingFloat: number) {
      const till = await request(server())
        .post('/api/v1/cash-registers')
        .set('Authorization', auth())
        .send({ branchId: biz.branchId, name: `Drawer till ${seq}`, code: `DRAWER-T${seq++}` })
        .expect(201);
      const opened = await request(server())
        .post('/api/v1/sales/shifts/open')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, cashRegisterId: till.body.data.id, openingFloat })
        .expect(201);
      return opened.body.data.id as string;
    }

    const closeShift = (countedCash: number) =>
      request(server()).post('/api/v1/sales/shifts/close').set('Authorization', auth()).send({ countedCash });

    const drawerRows = (shiftId: string) =>
      admin.cashTransaction.findMany({ where: { businessId: biz.businessId, shiftId }, orderBy: { createdAt: 'asc' } });

    async function customer(name: string) {
      const res = await request(server())
        .post('/api/v1/sales/customers')
        .set('Authorization', auth())
        .send({ name: `${name} ${seq++}` })
        .expect(201);
      return res.body.data.id as string;
    }

    it('A CARD SALE MOVES NO CASH: the drawer ledger stays empty and expected cash is still just the float', async () => {
      const shiftId = await freshShift(100);
      const variantId = await stocked();

      await request(server())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId, quantity: 2, unitPrice: 100 }],
          payments: [{ amount: 200, method: 'CARD' }],
        })
        .expect(201);

      expect(await drawerRows(shiftId)).toHaveLength(0);
      const active = await request(server()).get('/api/v1/sales/shifts/active').set('Authorization', auth()).expect(200);
      expect(active.body.data.expectedCash).toBe('100');
      expect(active.body.data.cashIn).toBe('0');

      await closeShift(100).expect(200);
    });

    it('A MIXED TENDER banks only the cash half', async () => {
      const shiftId = await freshShift(0);
      const variantId = await stocked();

      await request(server())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId, quantity: 3, unitPrice: 100 }],
          payments: [
            { amount: 120, method: 'CASH' },
            { amount: 100, method: 'CARD' },
            { amount: 80, method: 'WALLET' },
          ],
        })
        .expect(201);

      // One row, for 120 - not three, and not 300.
      const rows = await drawerRows(shiftId);
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('SALE_TENDER');
      expect(rows[0].amount.toString()).toBe('120');

      const active = await request(server()).get('/api/v1/sales/shifts/active').set('Authorization', auth()).expect(200);
      expect(active.body.data.expectedCash).toBe('120');
      await closeShift(120).expect(200);
    });

    it('A CARD REFUND TAKES NO CASH OUT, while a cash refund does', async () => {
      const shiftId = await freshShift(500);
      const cardItem = await stocked();
      const cashItem = await stocked();

      const cardSale = await request(server())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId: cardItem, quantity: 1, unitPrice: 100 }],
          payments: [{ amount: 100, method: 'CARD' }],
        })
        .expect(201);

      const cashSale = await request(server())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId: cashItem, quantity: 1, unitPrice: 100 }],
          payments: [{ amount: 100, method: 'CASH' }],
        })
        .expect(201);

      // Refunded to the card it was paid on: real money, real accounting,
      // but it never passes through the till.
      await request(server())
        .post(`/api/v1/sales/${cardSale.body.data.id}/returns`)
        .set('Authorization', auth())
        .send({
          items: [{ saleItemId: cardSale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          refund: { method: 'CARD', amount: 100 },
        })
        .expect(201);

      let rows = await drawerRows(shiftId);
      expect(rows.filter((r) => r.type === 'SALE_REFUND')).toHaveLength(0);

      // The cash one is handed over the counter, so it leaves the drawer.
      await request(server())
        .post(`/api/v1/sales/${cashSale.body.data.id}/returns`)
        .set('Authorization', auth())
        .send({
          items: [{ saleItemId: cashSale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          refund: { method: 'CASH', amount: 100 },
        })
        .expect(201);

      rows = await drawerRows(shiftId);
      const refunds = rows.filter((r) => r.type === 'SALE_REFUND');
      expect(refunds).toHaveLength(1);
      expect(refunds[0].amount.toString()).toBe('-100');

      // 500 float + 100 cash sale - 100 cash refund = 500. The card sale
      // and the card refund are both absent, and cancel to nothing anyway.
      const active = await request(server()).get('/api/v1/sales/shifts/active').set('Authorization', auth()).expect(200);
      expect(active.body.data.expectedCash).toBe('500');
      await closeShift(500).expect(200);
    });

    it('A DOWNWARD EXCHANGE refunds CASH out of the drawer - and the EXCHANGE CREDIT is not cash', async () => {
      const shiftId = await freshShift(1000);
      const oldItem = await stocked();
      const newItem = await stocked();
      const customerId = await customer('Downward cash');

      const sale = await request(server())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          customerId,
          items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
          payments: [{ amount: 100, method: 'CASH' }],
        })
        .expect(201);

      // 100 back, 80 out: 80 of the credit is spent on the replacement and
      // 20 is handed over in cash.
      const res = await request(server())
        .post(`/api/v1/sales/${sale.body.data.id}/exchanges`)
        .set('Authorization', auth())
        .send({
          returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          newItems: [{ variantId: newItem, quantity: 1, unitPrice: 80 }],
          refund: { method: 'CASH', amount: 20 },
          payments: [],
        })
        .expect(201);
      expect(res.body.data.exchangeCredit).toBe('80');
      expect(res.body.data.refunded).toBe('20');

      const rows = await drawerRows(shiftId);
      // Exactly TWO drawer rows: the original cash sale, and the 20 refund.
      // The 80 of exchange credit settled the replacement internally and
      // must NOT appear - if it did, expected cash would be short by 80.
      expect(rows.map((r) => [r.type, r.amount.toString()])).toEqual([
        ['SALE_TENDER', '100'],
        ['SALE_REFUND', '-20'],
      ]);
      expect(rows.some((r) => r.amount.toString() === '80')).toBe(false);

      // 1000 + 100 - 20 = 1080.
      const active = await request(server()).get('/api/v1/sales/shifts/active').set('Authorization', auth()).expect(200);
      expect(active.body.data.expectedCash).toBe('1080');
      await closeShift(1080).expect(200);
    });

    it('A DOWNWARD EXCHANGE refunded to CARD moves no cash at all', async () => {
      const shiftId = await freshShift(1000);
      const oldItem = await stocked();
      const newItem = await stocked();
      const customerId = await customer('Downward card');

      const sale = await request(server())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          customerId,
          items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
          payments: [{ amount: 100, method: 'CARD' }],
        })
        .expect(201);

      await request(server())
        .post(`/api/v1/sales/${sale.body.data.id}/exchanges`)
        .set('Authorization', auth())
        .send({
          returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          newItems: [{ variantId: newItem, quantity: 1, unitPrice: 80 }],
          refund: { method: 'CARD', amount: 20 },
          payments: [],
        })
        .expect(201);

      expect(await drawerRows(shiftId)).toHaveLength(0);
      const active = await request(server()).get('/api/v1/sales/shifts/active').set('Authorization', auth()).expect(200);
      expect(active.body.data.expectedCash).toBe('1000');
      await closeShift(1000).expect(200);
    });

    it('AN UPWARD EXCHANGE banks only the difference the customer actually hands over', async () => {
      const shiftId = await freshShift(1000);
      const oldItem = await stocked();
      const newItem = await stocked();
      const customerId = await customer('Upward cash');

      const sale = await request(server())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          customerId,
          items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
          payments: [{ amount: 100, method: 'CASH' }],
        })
        .expect(201);

      // 100 back, 150 out: the customer pays 50, not 150. The other 100 is
      // exchange credit, which is not money and must not reach the drawer.
      await request(server())
        .post(`/api/v1/sales/${sale.body.data.id}/exchanges`)
        .set('Authorization', auth())
        .send({
          returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          newItems: [{ variantId: newItem, quantity: 1, unitPrice: 150 }],
          payments: [{ amount: 50, method: 'CASH' }],
        })
        .expect(201);

      const rows = await drawerRows(shiftId);
      expect(rows.map((r) => [r.type, r.amount.toString()])).toEqual([
        ['SALE_TENDER', '100'],
        ['SALE_TENDER', '50'],
      ]);

      const active = await request(server()).get('/api/v1/sales/shifts/active').set('Authorization', auth()).expect(200);
      expect(active.body.data.expectedCash).toBe('1150');
      await closeShift(1150).expect(200);
    });
  });

  // ==================================================================
  describe('Closing is final, and closes once', () => {
    let seq = 0;

    async function freshShift(openingFloat: number) {
      const till = await request(server())
        .post('/api/v1/cash-registers')
        .set('Authorization', auth())
        .send({ branchId: biz.branchId, name: `Close till ${seq}`, code: `CLOSE-T${seq++}` })
        .expect(201);
      const opened = await request(server())
        .post('/api/v1/sales/shifts/open')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, cashRegisterId: till.body.data.id, openingFloat })
        .expect(201);
      return opened.body.data.id as string;
    }

    it('A SHIFT CANNOT BE CLOSED TWICE, and the second attempt changes nothing', async () => {
      const shiftId = await freshShift(60);

      await request(server())
        .post('/api/v1/sales/shifts/close')
        .set('Authorization', auth())
        .send({ countedCash: 55 })
        .expect(200);

      // There is no open shift left to close, so the second attempt is
      // refused outright rather than re-counting the drawer.
      const again = await request(server())
        .post('/api/v1/sales/shifts/close')
        .set('Authorization', auth())
        .send({ countedCash: 999 })
        .expect(409);
      expect(again.body.error.code).toBe('CONFLICT');

      // Rule 6: the counted amount is what the cashier first submitted.
      const row = await admin.shift.findUniqueOrThrow({ where: { id: shiftId } });
      expect(row.countedCash!.toString()).toBe('55');
      expect(row.status).toBe('CLOSED');

      // And exactly ONE variance entry exists - a second posting would
      // double-count the shortage in the books.
      const entries = await admin.journalEntry.findMany({
        where: { businessId: biz.businessId, sourceType: 'Shift', sourceId: shiftId },
      });
      expect(entries).toHaveLength(1);
    });

    it('CONCURRENCY: two simultaneous closes produce one close and one variance posting', async () => {
      const shiftId = await freshShift(80);

      const [a, b] = await Promise.all([
        request(server()).post('/api/v1/sales/shifts/close').set('Authorization', auth()).send({ countedCash: 70 }),
        request(server()).post('/api/v1/sales/shifts/close').set('Authorization', auth()).send({ countedCash: 70 }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      const row = await admin.shift.findUniqueOrThrow({ where: { id: shiftId } });
      expect(row.status).toBe('CLOSED');
      expect(row.countedCash!.toString()).toBe('70');

      // The financial effect happened once. Two entries here would mean the
      // shop booked a 10.00 shortage twice.
      const entries = await admin.journalEntry.findMany({
        where: { businessId: biz.businessId, sourceType: 'Shift', sourceId: shiftId },
        include: { lines: true },
      });
      expect(entries).toHaveLength(1);
      const debits = entries[0].lines.reduce((s, l) => s + Number(l.debit), 0);
      const credits = entries[0].lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(debits).toBeCloseTo(credits, 4);
      expect(debits).toBeCloseTo(10, 4);
    });

    it('AUDIT: opening, the manual movement and the close each leave a record', async () => {
      const shiftId = await freshShift(40);

      await request(server())
        .post(`/api/v1/sales/shifts/${shiftId}/cash-transactions`)
        .set('Authorization', auth())
        .send({ type: 'PAY_IN', amount: 10, reason: 'Change for the till' })
        .expect(201);

      await request(server())
        .post('/api/v1/sales/shifts/close')
        .set('Authorization', auth())
        .send({ countedCash: 50, notes: 'All present' })
        .expect(200);

      const shiftLogs = await admin.auditLog.findMany({
        where: { businessId: biz.businessId, entityType: 'Shift', entityId: shiftId },
        orderBy: { createdAt: 'asc' },
      });
      expect(shiftLogs.map((l) => l.action)).toEqual(['CREATE', 'UPDATE']);

      // The close record carries what was counted AND what was expected, so
      // the ledger's variance can always be traced back to the moment it
      // was decided - even though the cashier was never shown the figure.
      const closeLog = shiftLogs[1];
      expect(JSON.stringify(closeLog.after)).toContain('50');
      expect(JSON.stringify(closeLog.after)).toContain('expectedCash');

      const movementLogs = await admin.auditLog.findMany({
        where: { businessId: biz.businessId, entityType: 'CashTransaction' },
      });
      expect(movementLogs.some((l) => l.reason === 'Change for the till')).toBe(true);
    });
  });

  // ==================================================================
  describe('Who may touch the drawer, and whose drawer it is', () => {
    let seq = 0;

    /** A user holding exactly `permissionCodes` and nothing else. */
    async function userWith(permissionCodes: string[], label: string) {
      const role = await request(server())
        .post('/api/v1/roles')
        .set('Authorization', auth())
        .send({ name: `${label} ${seq++}`, permissionCodes })
        .expect(201);
      const email = `${label.toLowerCase().replace(/\s+/g, '-')}-${seq}@${biz.slug}.test`;
      await request(server())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: label, email, password: 'DrawerPass1!', roleIds: [role.body.data.id], branchIds: [biz.branchId] })
        .expect(201);
      const login = await request(server())
        .post('/api/v1/auth/login')
        .send({ businessSlug: biz.slug, email, password: 'DrawerPass1!' })
        .expect(200);
      return `Bearer ${login.body.data.accessToken}`;
    }

    it('PERMISSIONS: seeing registers, moving cash and reviewing a shift are three separate rights', async () => {
      // A till user: can list registers and open/close, but cannot move
      // cash by hand and cannot reconcile anybody.
      const tillUser = await userWith(
        ['cash_registers.view', 'shifts.view', 'shifts.open', 'shifts.close'],
        'Till only',
      );
      await request(server()).get('/api/v1/cash-registers').set('Authorization', tillUser).expect(200);

      const till = await request(server())
        .post('/api/v1/cash-registers')
        .set('Authorization', auth())
        .send({ branchId: biz.branchId, name: `Perm till ${seq}`, code: `PERM-T${seq++}` })
        .expect(201);
      const opened = await request(server())
        .post('/api/v1/sales/shifts/open')
        .set('Authorization', tillUser)
        .send({ warehouseId: biz.warehouseId, cashRegisterId: till.body.data.id, openingFloat: 0 })
        .expect(201);

      // No `cash.movement`: cannot hand-write a drawer row.
      await request(server())
        .post(`/api/v1/sales/shifts/${opened.body.data.id}/cash-transactions`)
        .set('Authorization', tillUser)
        .send({ type: 'PAY_IN', amount: 5, reason: 'nope' })
        .expect(403);

      // No `cash_registers.manage`: cannot invent a till.
      await request(server())
        .post('/api/v1/cash-registers')
        .set('Authorization', tillUser)
        .send({ branchId: biz.branchId, name: 'Rogue', code: `ROGUE-${seq++}` })
        .expect(403);

      await request(server())
        .post('/api/v1/sales/shifts/close')
        .set('Authorization', tillUser)
        .send({ countedCash: 0 })
        .expect(200);

      // No `shifts.reconcile`: cannot sign off their own variance.
      await request(server())
        .post(`/api/v1/sales/shifts/${opened.body.data.id}/reconcile`)
        .set('Authorization', tillUser)
        .send({})
        .expect(403);

      // And still no expected figure anywhere, on the list endpoint too.
      const list = await request(server()).get('/api/v1/sales/shifts').set('Authorization', tillUser).expect(200);
      for (const row of list.body.data) {
        expect(row).not.toHaveProperty('expectedCash');
        expect(row).not.toHaveProperty('variance');
      }
    });

    it('A REVIEWER sees the figures a till user cannot, on the very same shift', async () => {
      const reviewer = await userWith(['shifts.view', 'shifts.view_expected', 'shifts.reconcile'], 'Reviewer');
      const list = await request(server()).get('/api/v1/sales/shifts').set('Authorization', reviewer).expect(200);
      expect(list.body.data.length).toBeGreaterThan(0);
      for (const row of list.body.data) {
        expect(row).toHaveProperty('expectedCash');
      }
    });

    it('TENANT ISOLATION: another business sees none of this drawer and cannot move it', async () => {
      const other = await setupInventoryFixture(app, `cash-till-x${seq++}`);
      const otherAuth = `Bearer ${other.accessToken}`;

      const mine = await admin.shift.findFirstOrThrow({ where: { businessId: biz.businessId } });

      // Their register list is their own, and contains none of ours.
      const registers = await request(server()).get('/api/v1/cash-registers').set('Authorization', otherAuth).expect(200);
      expect(registers.body.data.every((r: { branchId: string }) => r.branchId !== biz.branchId)).toBe(true);

      // Our shifts are not in their history...
      const shifts = await request(server()).get('/api/v1/sales/shifts').set('Authorization', otherAuth).expect(200);
      expect(shifts.body.data.map((s: { id: string }) => s.id)).not.toContain(mine.id);

      // ...and our drawer is unreachable even with the id in hand.
      await request(server()).get(`/api/v1/sales/shifts/${mine.id}/cash-transactions`).set('Authorization', otherAuth).expect(404);
      await request(server())
        .post(`/api/v1/sales/shifts/${mine.id}/cash-transactions`)
        .set('Authorization', otherAuth)
        .send({ type: 'PAY_OUT', amount: 10, reason: 'theft' })
        .expect(404);
      await request(server())
        .post(`/api/v1/sales/shifts/${mine.id}/reconcile`)
        .set('Authorization', otherAuth)
        .send({})
        .expect(404);

      // Nothing moved.
      const rows = await admin.cashTransaction.findMany({ where: { shiftId: mine.id } });
      expect(rows.every((r) => r.reason !== 'theft')).toBe(true);
    });

    it('REGISTER DISCOVERY: the POS is offered its own branch’s ACTIVE tills, and retired ones stay out', async () => {
      const retired = await request(server())
        .post('/api/v1/cash-registers')
        .set('Authorization', auth())
        .send({ branchId: biz.branchId, name: 'Retired till', code: `RETIRED-${seq++}` })
        .expect(201);
      await request(server())
        .patch(`/api/v1/cash-registers/${retired.body.data.id}`)
        .set('Authorization', auth())
        .send({ isActive: false })
        .expect(200);

      const listed = await request(server())
        .get('/api/v1/cash-registers')
        .set('Authorization', auth())
        .query({ branchId: biz.branchId })
        .expect(200);
      const ids = listed.body.data.map((r: { id: string }) => r.id);
      expect(ids).not.toContain(retired.body.data.id);
      expect(listed.body.data.every((r: { branchId: string; isActive: boolean }) => r.branchId === biz.branchId && r.isActive)).toBe(true);

      // A retired till cannot host a shift either - discovery and the rule
      // agree, rather than the list merely being tidy.
      await request(server())
        .post('/api/v1/sales/shifts/open')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, cashRegisterId: retired.body.data.id, openingFloat: 0 })
        .expect(422);
    });
  });
});
