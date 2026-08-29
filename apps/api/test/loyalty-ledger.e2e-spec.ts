import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { registerAndLogin, RegisteredBusiness } from './utils/register-and-login';
import { computePointsEarned, resolveLoyaltyEarnRate } from '../src/modules/loyalty/domain/loyalty-earning';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Phase 8B - Loyalty Ledger. Real NestJS app + real PostgreSQL (erp_test)
 * with RLS + FORCE RLS active and the restricted `erp_app` runtime role.
 * No mocks: append-only-ness, tenant isolation, permission boundaries and
 * the impossibility of a negative balance are security and integrity
 * invariants, and a mock cannot prove any of them.
 */
describe('Loyalty ledger (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: RegisteredBusiness;
  let other: RegisteredBusiness;
  let customerId: string;
  let otherCustomerId: string;

  let keySeq = 0;
  const nextKey = (p: string) => `${p}-${Date.now()}-${keySeq++}`;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    biz = await registerAndLogin(app, 'loyalty-a');
    other = await registerAndLogin(app, 'loyalty-b');

    customerId = await createCustomer(biz.accessToken, 'Loyal Customer');
    otherCustomerId = await createCustomer(other.accessToken, 'Other Tenant Customer');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  function auth() {
    return `Bearer ${biz.accessToken}`;
  }

  async function createCustomer(token: string, name: string) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
      .expect(201);
    return res.body.data.id as string;
  }

  function adjust(body: Record<string, unknown>, token = auth(), target = customerId) {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/customers/${target}/points/adjust`)
      .set('Authorization', token)
      .send(body);
  }

  async function balance(target = customerId, token = auth()) {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/sales/customers/${target}/points`)
      .set('Authorization', token)
      .expect(200);
    return res.body.data;
  }

  async function loginAs(roleName: string, emailPrefix: string) {
    const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: roleName } });
    const email = `${emailPrefix}@${biz.slug}.test`;
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: emailPrefix, email, password: 'RoleUserPass1!', roleIds: [role.id], branchIds: [] })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'RoleUserPass1!', businessSlug: biz.slug })
      .expect(200);
    return `Bearer ${login.body.data.accessToken}`;
  }

  // ------------------------------------------------------------------
  describe('Derived balance - there is no stored balance anywhere', () => {
    it('starts at zero for a customer with no ledger events', async () => {
      const b = await balance();
      expect(b.balance).toBe('0');
      expect(b.eventCount).toBe(0);
    });

    it('no column named like a loyalty balance exists on customers or anywhere else', async () => {
      const rows: Array<{ table_name: string; column_name: string }> = await admin.$queryRawUnsafe(`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name LIKE '%point%balance%' OR column_name LIKE '%loyalty%balance%'
               OR column_name LIKE '%points_balance%' OR column_name = 'loyalty_points')
      `);
      expect(rows).toEqual([]);
    });

    it('the balance always equals SUM(points) computed independently from the raw table', async () => {
      await adjust({ points: 120, reason: 'Signup bonus', idempotencyKey: nextKey('a') }).expect(201);
      await adjust({ points: 30.5, reason: 'Goodwill', idempotencyKey: nextKey('a') }).expect(201);
      await adjust({ points: -20, reason: 'Correction of a mis-keyed grant', idempotencyKey: nextKey('a') }).expect(201);

      const agg = await admin.customerPoints.aggregate({
        where: { businessId: biz.businessId, customerId },
        _sum: { points: true },
      });
      const b = await balance();
      expect(new Prisma.Decimal(b.balance).equals(agg._sum.points ?? 0)).toBe(true);
      expect(new Prisma.Decimal(b.balance).toString()).toBe('130.5');
      expect(b.eventCount).toBe(3);
    });

    it('the ledger listing reports the whole balance, never the filtered page subtotal', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points/ledger?type=ADJUSTMENT&limit=1`)
        .set('Authorization', auth())
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.pagination.total).toBe(3);
      expect(res.body.balance).toBe('130.5');
    });

    it('rejects an out-of-range limit', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points/ledger?limit=999`)
        .set('Authorization', auth())
        .expect(422);
    });
  });

  // ------------------------------------------------------------------
  describe('Append-only: proven at the database layer', () => {
    it('erp_app has SELECT and INSERT on customer_points and nothing else', async () => {
      const rows: Array<{ privilege_type: string }> = await admin.$queryRawUnsafe(`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'erp_app' AND table_name = 'customer_points'
        ORDER BY privilege_type
      `);
      expect(rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
    });

    it('the runtime role cannot UPDATE or DELETE a ledger row even with the right tenant set', async () => {
      const row = await admin.customerPoints.findFirstOrThrow({ where: { businessId: biz.businessId } });
      const runtime = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
      try {
        await expect(
          runtime.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
            return tx.$executeRawUnsafe(`UPDATE customer_points SET points = 999999 WHERE id = '${row.id}'`);
          }),
        ).rejects.toThrow(/permission denied/i);

        await expect(
          runtime.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
            return tx.$executeRawUnsafe(`DELETE FROM customer_points WHERE id = '${row.id}'`);
          }),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await runtime.$disconnect();
      }

      const after = await admin.customerPoints.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.points.toString()).toBe(row.points.toString());
    });

    it('a correction is a new row, and the original event survives untouched', async () => {
      const before = await admin.customerPoints.findFirstOrThrow({
        where: { businessId: biz.businessId, customerId },
        orderBy: { createdAt: 'asc' },
      });
      await adjust({ points: -5, reason: 'Later correction', idempotencyKey: nextKey('corr') }).expect(201);
      const after = await admin.customerPoints.findUniqueOrThrow({ where: { id: before.id } });

      expect(after.points.toString()).toBe(before.points.toString());
      expect(after.description).toBe(before.description);
      expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
      expect((await balance()).balance).toBe('125.5');
    });

    it('the database rejects a zero-point row and a sign that contradicts its type', async () => {
      const base = `'${biz.businessId}', '${customerId}'`;
      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO customer_points (id, business_id, customer_id, type, points) VALUES (gen_random_uuid(), ${base}, 'ADJUSTMENT', 0)`,
        ),
      ).rejects.toThrow(/customer_points_nonzero/);

      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO customer_points (id, business_id, customer_id, type, points) VALUES (gen_random_uuid(), ${base}, 'EARN', -10)`,
        ),
      ).rejects.toThrow(/customer_points_sign_matches_type/);

      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO customer_points (id, business_id, customer_id, type, points) VALUES (gen_random_uuid(), ${base}, 'REDEEM', 10)`,
        ),
      ).rejects.toThrow(/customer_points_sign_matches_type/);

      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO customer_points (id, business_id, customer_id, type, points) VALUES (gen_random_uuid(), ${base}, 'RETURN_CLAWBACK', 10)`,
        ),
      ).rejects.toThrow(/customer_points_sign_matches_type/);
    });

    it('the database rejects a half-populated earning snapshot and a non-positive rate', async () => {
      const base = `'${biz.businessId}', '${customerId}'`;
      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO customer_points (id, business_id, customer_id, type, points, basis_amount) VALUES (gen_random_uuid(), ${base}, 'EARN', 5, 100)`,
        ),
      ).rejects.toThrow(/customer_points_snapshot_complete/);

      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO customer_points (id, business_id, customer_id, type, points, basis_amount, rate_snapshot) VALUES (gen_random_uuid(), ${base}, 'EARN', 5, 100, 0)`,
        ),
      ).rejects.toThrow(/customer_points_rate_positive/);
    });
  });

  // ------------------------------------------------------------------
  describe('Negative balances are impossible', () => {
    it('rejects a deduction larger than the current balance and writes nothing', async () => {
      const before = await balance();
      const rowsBefore = await admin.customerPoints.count({ where: { businessId: biz.businessId, customerId } });

      const res = await adjust({ points: -100000, reason: 'Overdraw attempt', idempotencyKey: nextKey('over') }).expect(409);
      expect(JSON.stringify(res.body)).toMatch(/balance/i);

      expect((await balance()).balance).toBe(before.balance);
      expect(await admin.customerPoints.count({ where: { businessId: biz.businessId, customerId } })).toBe(rowsBefore);
    });

    it('allows a deduction down to exactly zero', async () => {
      const scratch = await createCustomer(biz.accessToken, 'Zero Out');
      await adjust({ points: 40, reason: 'Grant', idempotencyKey: nextKey('z') }, auth(), scratch).expect(201);
      await adjust({ points: -40, reason: 'Full clawback', idempotencyKey: nextKey('z') }, auth(), scratch).expect(201);
      expect((await balance(scratch)).balance).toBe('0');
      // ...and one more point out is refused.
      await adjust({ points: -1, reason: 'One too many', idempotencyKey: nextKey('z') }, auth(), scratch).expect(409);
    });

    it('two concurrent deductions that are each affordable but jointly overdrawn cannot both succeed', async () => {
      const scratch = await createCustomer(biz.accessToken, 'Race Customer');
      await adjust({ points: 100, reason: 'Seed', idempotencyKey: nextKey('r') }, auth(), scratch).expect(201);

      // Fired simultaneously - neither awaits before the other starts.
      const results = await Promise.all([
        adjust({ points: -70, reason: 'Concurrent A', idempotencyKey: nextKey('rA') }, auth(), scratch),
        adjust({ points: -70, reason: 'Concurrent B', idempotencyKey: nextKey('rB') }, auth(), scratch),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409]);

      const final = await balance(scratch);
      expect(new Prisma.Decimal(final.balance).greaterThanOrEqualTo(0)).toBe(true);
      expect(final.balance).toBe('30');
    });

    it('no customer in the database ever holds a negative derived balance', async () => {
      const rows: Array<{ customer_id: string; total: Prisma.Decimal }> = await admin.$queryRawUnsafe(`
        SELECT customer_id, SUM(points) AS total FROM customer_points GROUP BY customer_id HAVING SUM(points) < 0
      `);
      expect(rows).toEqual([]);
    });
  });

  // ------------------------------------------------------------------
  describe('Idempotency', () => {
    it('replaying the same key with the same payload returns the original row and writes nothing new', async () => {
      const key = nextKey('idem');
      const first = await adjust({ points: 15, reason: 'Idempotent grant', idempotencyKey: key }).expect(201);
      const countAfterFirst = await admin.customerPoints.count({ where: { businessId: biz.businessId } });

      const replay = await adjust({ points: 15, reason: 'Idempotent grant', idempotencyKey: key }).expect(201);
      expect(replay.body.data.id).toBe(first.body.data.id);
      expect(await admin.customerPoints.count({ where: { businessId: biz.businessId } })).toBe(countAfterFirst);
    });

    it('rejects the same key reused with a DIFFERENT payload rather than returning the stale row', async () => {
      const key = nextKey('idem');
      await adjust({ points: 5, reason: 'Original', idempotencyKey: key }).expect(201);
      await adjust({ points: 99, reason: 'Original', idempotencyKey: key }).expect(409);
      await adjust({ points: 5, reason: 'Different reason', idempotencyKey: key }).expect(409);
    });

    it('requires an idempotency key - a manual adjustment has no source document to dedupe on', async () => {
      await adjust({ points: 5, reason: 'No key' }).expect(422);
    });

    it('two truly concurrent requests with the same key produce exactly one ledger row', async () => {
      const scratch = await createCustomer(biz.accessToken, 'Concurrent Idem');
      const key = nextKey('cidem');
      const results = await Promise.all([
        adjust({ points: 25, reason: 'Same key', idempotencyKey: key }, auth(), scratch),
        adjust({ points: 25, reason: 'Same key', idempotencyKey: key }, auth(), scratch),
      ]);
      expect(results.some((r) => r.status === 201)).toBe(true);
      const rows = await admin.customerPoints.count({ where: { businessId: biz.businessId, idempotencyKey: key } });
      expect(rows).toBe(1);
      expect((await balance(scratch)).balance).toBe('25');
    });
  });

  // ------------------------------------------------------------------
  describe('Validation', () => {
    it('rejects a zero adjustment, a missing reason and a non-numeric value', async () => {
      await adjust({ points: 0, reason: 'Nothing', idempotencyKey: nextKey('v') }).expect(422);
      await adjust({ points: 10, reason: '   ', idempotencyKey: nextKey('v') }).expect(422);
      await adjust({ points: 'abc', reason: 'Bad', idempotencyKey: nextKey('v') }).expect(422);
    });

    it('404s for a customer that does not exist in this tenant', async () => {
      const ghost = '00000000-0000-4000-8000-000000000000';
      await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${ghost}/points`)
        .set('Authorization', auth())
        .expect(404);
      await adjust({ points: 5, reason: 'Ghost', idempotencyKey: nextKey('g') }, auth(), ghost).expect(404);
    });
  });

  // ------------------------------------------------------------------
  describe('BD-3 earning rule (deterministic, floor, snapshotted)', () => {
    it('floors rather than rounding half-up', () => {
      // 99.99 * 1 = 99.99 -> 99, not 100.
      expect(computePointsEarned('99.99', '1').toString()).toBe('99');
      expect(computePointsEarned('100', '0.5').toString()).toBe('50');
      expect(computePointsEarned('99', '0.5').toString()).toBe('49'); // 49.5 floors to 49
      expect(computePointsEarned('0.9', '1').toString()).toBe('0');
    });

    it('is deterministic and free of floating-point drift', () => {
      // 0.1 + 0.2 style inputs that a float would mangle.
      const a = computePointsEarned('1000.15', '0.3');
      const b = computePointsEarned('1000.15', '0.3');
      expect(a.toString()).toBe(b.toString());
      expect(a.toString()).toBe('300'); // 300.045 floors to 300
    });

    it('earns nothing from a non-positive eligible amount', () => {
      expect(computePointsEarned('0', '2').toString()).toBe('0');
      expect(computePointsEarned('-50', '2').toString()).toBe('0');
    });

    it('resolves the rate from Setting, and treats absent or invalid configuration as no programme', async () => {
      const prisma = app.get(PrismaService);

      const unset = await prisma.withTenant(biz.businessId, (tx) => resolveLoyaltyEarnRate(tx, biz.businessId));
      expect(unset).toBeNull();

      for (const bad of [0, -1, 'not-a-number', null]) {
        await request(app.getHttpServer())
          .put('/api/v1/settings')
          .set('Authorization', auth())
          .send({ key: 'loyalty.points_per_currency_unit', value: bad })
          .expect(200);
        const r = await prisma.withTenant(biz.businessId, (tx) => resolveLoyaltyEarnRate(tx, biz.businessId));
        expect(r).toBeNull();
      }

      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.points_per_currency_unit', value: 2 })
        .expect(200);
      const good = await prisma.withTenant(biz.businessId, (tx) => resolveLoyaltyEarnRate(tx, biz.businessId));
      expect(good).not.toBeNull();
      expect(good!.toString()).toBe('2');
    });

    it('a snapshotted EARN row is unaffected by a later rate change', async () => {
      // Written directly: the sale path that produces EARN rows is Phase
      // 8E's approved scope, so this proves the SNAPSHOT property of the
      // ledger row itself, which is what Phase 8B owns.
      const scratch = await createCustomer(biz.accessToken, 'Snapshot Customer');
      const earned = computePointsEarned('250', '2');
      const row = await admin.customerPoints.create({
        data: {
          businessId: biz.businessId,
          customerId: scratch,
          type: 'EARN',
          points: earned,
          basisAmount: new Prisma.Decimal('250'),
          rateSnapshot: new Prisma.Decimal('2'),
          referenceType: 'Sale',
          referenceId: '00000000-0000-4000-8000-00000000dead',
        },
      });
      expect(row.points.toString()).toBe('500');

      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.points_per_currency_unit', value: 99 })
        .expect(200);

      const after = await admin.customerPoints.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.points.toString()).toBe('500');
      expect(after.rateSnapshot!.toString()).toBe('2');
      expect(after.basisAmount!.toString()).toBe('250');
      // The row can reproduce its own arithmetic with no current config.
      expect(computePointsEarned(after.basisAmount!, after.rateSnapshot!).toString()).toBe(after.points.toString());
      expect((await balance(scratch)).balance).toBe('500');
    });
  });

  // ------------------------------------------------------------------
  describe('No accounting effect', () => {
    it('adjusting points creates no journal entry and no customer money transaction', async () => {
      const entriesBefore = await admin.journalEntry.count({ where: { businessId: biz.businessId } });
      const txnsBefore = await admin.customerTransaction.count({ where: { businessId: biz.businessId } });

      await adjust({ points: 60, reason: 'Points are not money', idempotencyKey: nextKey('gl') }).expect(201);

      expect(await admin.journalEntry.count({ where: { businessId: biz.businessId } })).toBe(entriesBefore);
      expect(await admin.customerTransaction.count({ where: { businessId: biz.businessId } })).toBe(txnsBefore);
    });

    it('no loyalty liability account exists and no accounting mapping references loyalty', async () => {
      const accounts = await admin.account.findMany({
        where: { businessId: biz.businessId, name: { contains: 'oyalt' } },
      });
      expect(accounts).toEqual([]);
      const cols: Array<{ count: bigint }> = await admin.$queryRawUnsafe(`
        SELECT count(*) AS count FROM information_schema.columns
        WHERE table_name = 'customer_points'
          AND (column_name LIKE '%journal%' OR column_name LIKE '%account%')
      `);
      expect(Number(cols[0].count)).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  describe('Tenant isolation', () => {
    it("business B cannot read or adjust business A's customer's points", async () => {
      const otherAuth = `Bearer ${other.accessToken}`;
      await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points`)
        .set('Authorization', otherAuth)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points/ledger`)
        .set('Authorization', otherAuth)
        .expect(404);
      await adjust({ points: 10, reason: 'Cross tenant', idempotencyKey: nextKey('x') }, otherAuth, customerId).expect(404);
    });

    it("business B's own ledger is unaffected by business A's activity", async () => {
      const otherAuth = `Bearer ${other.accessToken}`;
      const b = await balance(otherCustomerId, otherAuth);
      expect(b.balance).toBe('0');
      expect(b.eventCount).toBe(0);
    });

    it('RLS blocks a cross-tenant read at the database layer, not merely in application code', async () => {
      const row = await admin.customerPoints.findFirstOrThrow({ where: { businessId: biz.businessId } });
      const runtime = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
      try {
        const rows = await runtime.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${other.businessId}'`);
          return tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM customer_points WHERE id = '${row.id}'`);
        });
        expect(rows).toHaveLength(0);
      } finally {
        await runtime.$disconnect();
      }
    });

    it('an unfiltered read with no tenant context returns nothing, and a cross-tenant INSERT is refused by WITH CHECK', async () => {
      const runtime = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
      try {
        const rows = await runtime.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM customer_points`);
        expect(rows).toHaveLength(0);

        await expect(
          runtime.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${other.businessId}'`);
            return tx.$executeRawUnsafe(
              `INSERT INTO customer_points (id, business_id, customer_id, type, points) VALUES (gen_random_uuid(), '${biz.businessId}', '${customerId}', 'ADJUSTMENT', 10)`,
            );
          }),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await runtime.$disconnect();
      }
    });
  });

  // ------------------------------------------------------------------
  describe('Permissions', () => {
    it('an unauthenticated caller reaches no loyalty route', async () => {
      await request(app.getHttpServer()).get(`/api/v1/sales/customers/${customerId}/points`).expect(401);
      await request(app.getHttpServer()).post(`/api/v1/sales/customers/${customerId}/points/adjust`).send({}).expect(401);
    });

    it('a CASHIER may read a balance at the till but may NOT adjust it', async () => {
      const token = await loginAs('CASHIER', 'loycashier');
      await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points`)
        .set('Authorization', token)
        .expect(200);
      await adjust({ points: 10, reason: 'Cashier grant', idempotencyKey: nextKey('p') }, token).expect(403);
    });

    it('a SALES_EMPLOYEE may read but may NOT adjust', async () => {
      const token = await loginAs('SALES_EMPLOYEE', 'loysalesemp');
      await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points/ledger`)
        .set('Authorization', token)
        .expect(200);
      await adjust({ points: 10, reason: 'Sales grant', idempotencyKey: nextKey('p') }, token).expect(403);
    });

    it('a BRANCH_MANAGER may read but may NOT adjust', async () => {
      const token = await loginAs('BRANCH_MANAGER', 'loybranchmgr');
      await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points`)
        .set('Authorization', token)
        .expect(200);
      await adjust({ points: 10, reason: 'BM grant', idempotencyKey: nextKey('p') }, token).expect(403);
    });

    it('an ACCOUNTANT may both read and adjust', async () => {
      const token = await loginAs('ACCOUNTANT', 'loyaccountant');
      await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points`)
        .set('Authorization', token)
        .expect(200);
      const res = await adjust({ points: 7, reason: 'Accountant correction', idempotencyKey: nextKey('p') }, token).expect(201);
      expect(res.body.data.type).toBe('ADJUSTMENT');
    });

    it('an INVENTORY_MANAGER has no loyalty access at all', async () => {
      const token = await loginAs('INVENTORY_MANAGER', 'loyinvmgr');
      await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}/points`)
        .set('Authorization', token)
        .expect(403);
    });
  });

  // ------------------------------------------------------------------
  describe('Audit trail', () => {
    it('every manual adjustment records who made it and why', async () => {
      const res = await adjust({ points: 11, reason: 'Audited grant', idempotencyKey: nextKey('aud') }).expect(201);
      const row = res.body.data;
      expect(row.createdBy).toBe(biz.ownerUserId);
      expect(row.description).toBe('Audited grant');

      const log = await admin.auditLog.findFirst({
        where: { businessId: biz.businessId, entityType: 'CustomerPoints', entityId: row.id },
      });
      expect(log).not.toBeNull();
      expect(log!.userId).toBe(biz.ownerUserId);
    });
  });
});
