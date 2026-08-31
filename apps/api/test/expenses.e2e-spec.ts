import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';

/**
 * Phase 10 (10H) — expenses.
 *
 * The claim that makes this more than a form: A CASH EXPENSE LEAVES THE
 * DRAWER, and the drawer ledger says so in the same transaction. Without
 * that, paying the window cleaner out of the till shows up at blind close
 * as a shortage the cashier cannot explain - and BD-17's whole guarantee
 * is that expected cash is derivable because the drawer can never disagree
 * with the documents.
 */
describe('Expenses (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let rentCategoryId: string;
  let seq = 0;

  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'expenses');
    rentCategoryId = await category('Rent', '5300');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function accountByCode(code: string) {
    return admin.account.findFirstOrThrow({ where: { businessId: biz.businessId, code } });
  }

  async function category(name: string, accountCode: string) {
    const account = await accountByCode(accountCode);
    const res = await request(app.getHttpServer())
      .post('/api/v1/expense-categories')
      .set('Authorization', auth())
      .send({ name: `${name} ${seq++}`, accountId: account.id })
      .expect(201);
    return res.body.data.id as string;
  }

  const spend = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/api/v1/expenses').set('Authorization', auth()).send(body);

  async function entryFor(sourceId: string) {
    return admin.journalEntry.findFirstOrThrow({
      where: { sourceType: 'Expense', sourceId },
      include: { lines: { include: { account: true } } },
    });
  }
  function netDebitOnCode(
    entry: { lines: { account: { code: string }; debit: Prisma.Decimal; credit: Prisma.Decimal }[] },
    code: string,
  ) {
    return entry.lines.filter((l) => l.account.code === code).reduce((s, l) => s.plus(l.debit).minus(l.credit), D(0)).toString();
  }

  // ==================================================================
  it('a CASH expense leaves the drawer, and the drawer ledger says so', async () => {
    const res = await spend({ expenseCategoryId: rentCategoryId, amount: 250, paymentMethod: 'CASH', description: 'Window cleaner' }).expect(201);

    const expense = await admin.expense.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(expense.expenseNumber).toMatch(/^EXP-[A-F0-9]{8}$/);
    expect(expense.amount.toString()).toBe('250');
    expect(expense.shiftId).toBe(biz.activeShiftId);

    // The drawer movement, in the same transaction, and NEGATIVE - money
    // left. The sign is enforced by the cash_transactions CHECK.
    const drawer = await admin.cashTransaction.findFirstOrThrow({
      where: { businessId: biz.businessId, referenceType: 'Expense', referenceId: expense.id },
    });
    expect(drawer.type).toBe('EXPENSE');
    expect(drawer.amount.toString()).toBe('-250');

    // Dr the category's account, Cr cash. Two lines, balanced.
    const entry = await entryFor(expense.id);
    expect(netDebitOnCode(entry, '5300')).toBe('250');
    expect(netDebitOnCode(entry, '1010')).toBe('-250');
    expect(entry.lines.length).toBe(2);
  });

  it('shows up in EXPECTED CASH at close, so the till reconciles instead of showing a phantom shortage', async () => {
    // A fresh business, so the shift's arithmetic is entirely ours.
    const shop = await setupSalesFixture(app, `expcash${seq++}`);
    const shopAuth = `Bearer ${shop.accessToken}`;
    const account = await admin.account.findFirstOrThrow({ where: { businessId: shop.businessId, code: '5300' } });
    const cat = await request(app.getHttpServer())
      .post('/api/v1/expense-categories')
      .set('Authorization', shopAuth)
      .send({ name: 'Cleaning', accountId: account.id })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/sales/shifts/${shop.activeShiftId}/cash-transactions`)
      .set('Authorization', shopAuth)
      .send({ type: 'PAY_IN', amount: 500, reason: 'float top-up' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/expenses')
      .set('Authorization', shopAuth)
      .send({ expenseCategoryId: cat.body.data.id, amount: 120, paymentMethod: 'CASH' })
      .expect(201);

    // 0 float + 500 in - 120 out = 380. Counting exactly that closes clean.
    const closed = await request(app.getHttpServer())
      .post('/api/v1/sales/shifts/close')
      .set('Authorization', shopAuth)
      .send({ countedCash: 380 })
      .expect(200);
    expect(closed.body.data.variance).toBe('0');

    // No variance entry is posted when there is nothing to explain.
    const variance = await admin.journalEntry.findFirst({
      where: { businessId: shop.businessId, sourceType: 'Shift', sourceId: shop.activeShiftId },
    });
    expect(variance).toBeNull();
  });

  it('a NON-CASH expense posts to the GL but never touches a drawer', async () => {
    const res = await spend({
      expenseCategoryId: rentCategoryId,
      amount: 4000,
      paymentMethod: 'BANK_TRANSFER',
      reference: 'TRF-991',
    }).expect(201);

    const expense = await admin.expense.findUniqueOrThrow({ where: { id: res.body.data.id } });
    // No shift, by construction: an expense paid by bank transfer
    // attributed to a till would be counted as a shortage at blind close -
    // money the cashier never touched.
    expect(expense.shiftId).toBeNull();
    expect(
      await admin.cashTransaction.count({ where: { businessId: biz.businessId, referenceId: expense.id } }),
    ).toBe(0);

    const entry = await entryFor(expense.id);
    expect(netDebitOnCode(entry, '5300')).toBe('4000');
    expect(netDebitOnCode(entry, '1040')).toBe('-4000'); // Bank, not Cash
    expect(netDebitOnCode(entry, '1010')).toBe('0');
  });

  it('refuses a CASH expense with no open shift', async () => {
    const shop = await setupSalesFixture(app, `noshift${seq++}`);
    const shopAuth = `Bearer ${shop.accessToken}`;
    const account = await admin.account.findFirstOrThrow({ where: { businessId: shop.businessId, code: '5300' } });
    const cat = await request(app.getHttpServer())
      .post('/api/v1/expense-categories')
      .set('Authorization', shopAuth)
      .send({ name: 'Sundries', accountId: account.id })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/sales/shifts/close')
      .set('Authorization', shopAuth)
      .send({ countedCash: 0 })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/expenses')
      .set('Authorization', shopAuth)
      .send({ expenseCategoryId: cat.body.data.id, amount: 10, paymentMethod: 'CASH' })
      .expect(409);
    // ...but a bank transfer needs no till at all.
    await request(app.getHttpServer())
      .post('/api/v1/expenses')
      .set('Authorization', shopAuth)
      .send({ expenseCategoryId: cat.body.data.id, amount: 10, paymentMethod: 'BANK_TRANSFER' })
      .expect(201);
  });

  // ==================================================================
  describe('Categories', () => {
    it('must post to an EXPENSE account - never to Revenue, Cash or Inventory', async () => {
      for (const code of ['4100', '1010', '1200', '2100']) {
        const account = await accountByCode(code);
        const res = await request(app.getHttpServer())
          .post('/api/v1/expense-categories')
          .set('Authorization', auth())
          .send({ name: `Bad ${code} ${seq++}`, accountId: account.id })
          .expect(422);
        expect(JSON.stringify(res.body)).toMatch(/EXPENSE account/i);
      }
    });

    it('is retired rather than deleted, and a retired one cannot take new spending', async () => {
      const id = await category('Retiring', '5300');
      await spend({ expenseCategoryId: id, amount: 5, paymentMethod: 'CASH' }).expect(201);

      await request(app.getHttpServer())
        .patch(`/api/v1/expense-categories/${id}`)
        .set('Authorization', auth())
        .send({ isActive: false })
        .expect(200);

      await spend({ expenseCategoryId: id, amount: 5, paymentMethod: 'CASH' }).expect(409);

      // The row survives, so the expense already posted against it stays
      // explicable forever.
      const still = await admin.expenseCategory.findUniqueOrThrow({ where: { id } });
      expect(still.isActive).toBe(false);
    });

    it('remapping the account changes FUTURE expenses only - a posted entry is never rewritten', async () => {
      const id = await category('Remapped', '5300');
      const first = await spend({ expenseCategoryId: id, amount: 60, paymentMethod: 'CASH' }).expect(201);
      expect(netDebitOnCode(await entryFor(first.body.data.id), '5300')).toBe('60');

      const other = await accountByCode('5200');
      await request(app.getHttpServer())
        .patch(`/api/v1/expense-categories/${id}`)
        .set('Authorization', auth())
        .send({ accountId: other.id })
        .expect(200);

      // The historical entry, re-read AFTER the remap.
      expect(netDebitOnCode(await entryFor(first.body.data.id), '5300')).toBe('60');
      expect(netDebitOnCode(await entryFor(first.body.data.id), '5200')).toBe('0');

      // A NEW expense lands in the new account.
      const second = await spend({ expenseCategoryId: id, amount: 70, paymentMethod: 'CASH' }).expect(201);
      expect(netDebitOnCode(await entryFor(second.body.data.id), '5200')).toBe('70');
    });
  });

  // ==================================================================
  describe('Guarantees', () => {
    it('is APPEND-ONLY at the database level: SELECT and INSERT, nothing else', async () => {
      const rows: Array<{ privilege_type: string }> = await admin.$queryRawUnsafe(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'erp_app' AND table_name = 'expenses'`,
      );
      expect(rows.map((r) => r.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
    });

    it('enforces RLS and FORCE RLS on both tables, with a policy carrying BOTH halves', async () => {
      for (const table of ['expenses', 'expense_categories']) {
        const cls: Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }> = await admin.$queryRawUnsafe(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
          table,
        );
        expect({ table, ...cls[0] }).toEqual({ table, relrowsecurity: true, relforcerowsecurity: true });
        const policies: Array<{ qual: string | null; with_check: string | null }> = await admin.$queryRawUnsafe(
          `SELECT qual, with_check FROM pg_policies WHERE tablename = $1`,
          table,
        );
        expect(policies.length).toBe(1);
        expect(policies[0].qual).toContain('current_tenant_id');
        expect(policies[0].with_check).toContain('current_tenant_id');
      }
    });

    it('refuses a zero or negative amount, in the schema AND at the database level', async () => {
      await spend({ expenseCategoryId: rentCategoryId, amount: 0, paymentMethod: 'CASH' }).expect(422);
      await spend({ expenseCategoryId: rentCategoryId, amount: -5, paymentMethod: 'CASH' }).expect(422);
      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO expenses (id, business_id, branch_id, expense_category_id, expense_number, amount, payment_method, expense_date)
             VALUES (gen_random_uuid()::text, $1, $2, $3, 'EXP-BAD', 0, 'BANK_TRANSFER', now())`,
          biz.businessId,
          biz.branchId,
          rentCategoryId,
        ),
      ).rejects.toThrow(/expenses_amount_positive/);
    });

    it('refuses a non-cash expense that claims a shift, at the database level', async () => {
      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO expenses (id, business_id, branch_id, expense_category_id, shift_id, expense_number, amount, payment_method, expense_date)
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'EXP-BAD2', 10, 'BANK_TRANSFER', now())`,
          biz.businessId,
          biz.branchId,
          rentCategoryId,
          biz.activeShiftId,
        ),
      ).rejects.toThrow(/expenses_cash_requires_shift/);
    });

    it('replays one idempotency key to the SAME expense, and rejects a different amount under it', async () => {
      const key = `exp-key-${seq++}`;
      const first = await spend({ expenseCategoryId: rentCategoryId, amount: 33, paymentMethod: 'CASH', idempotencyKey: key }).expect(201);
      const second = await spend({ expenseCategoryId: rentCategoryId, amount: 33, paymentMethod: 'CASH', idempotencyKey: key }).expect(201);
      expect(second.body.data.id).toBe(first.body.data.id);

      // The money left the drawer exactly once.
      expect(
        await admin.cashTransaction.count({ where: { businessId: biz.businessId, referenceId: first.body.data.id } }),
      ).toBe(1);

      await spend({ expenseCategoryId: rentCategoryId, amount: 99, paymentMethod: 'CASH', idempotencyKey: key }).expect(409);
    });

    it('separates recording spending from deciding where it lands', async () => {
      const role = await request(app.getHttpServer())
        .post('/api/v1/roles')
        .set('Authorization', auth())
        .send({ name: `Spender ${seq++}`, permissionCodes: ['expenses.view', 'expenses.create', 'shifts.view'] })
        .expect(201);
      const email = `spender${seq}@${biz.slug}.test`;
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'spender', email, password: 'RoleUserPass1!', roleIds: [role.body.data.id], branchIds: [] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'RoleUserPass1!', businessSlug: biz.slug })
        .expect(200);
      const token = `Bearer ${login.body.data.accessToken}`;

      // Can see and record spending...
      await request(app.getHttpServer()).get('/api/v1/expenses').set('Authorization', token).expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/expenses')
        .set('Authorization', token)
        .send({ expenseCategoryId: rentCategoryId, amount: 12, paymentMethod: 'BANK_TRANSFER' })
        .expect(201);

      // ...but cannot decide which GL account a kind of expense lands in.
      const account = await accountByCode('5300');
      await request(app.getHttpServer())
        .post('/api/v1/expense-categories')
        .set('Authorization', token)
        .send({ name: 'Sneaky', accountId: account.id })
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/api/v1/expense-categories/${rentCategoryId}`)
        .set('Authorization', token)
        .send({ accountId: account.id })
        .expect(403);
    });

    it('cannot reach another tenant’s category', async () => {
      const other = await setupSalesFixture(app, `expother${seq++}`);
      const account = await admin.account.findFirstOrThrow({ where: { businessId: other.businessId, code: '5300' } });
      const theirs = await request(app.getHttpServer())
        .post('/api/v1/expense-categories')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ name: 'Theirs', accountId: account.id })
        .expect(201);

      await spend({ expenseCategoryId: theirs.body.data.id, amount: 10, paymentMethod: 'BANK_TRANSFER' }).expect(404);
    });
  });
});
