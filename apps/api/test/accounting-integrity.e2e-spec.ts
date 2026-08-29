import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';
import { registerAndLogin } from './utils/register-and-login';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountingEngineService } from '../src/engines/accounting/accounting-engine.service';

describe('Accounting: double-entry integrity, immutability, reversal, RLS, permissions (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let appRoleClient: PrismaClient;
  let biz: SalesFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    appRoleClient = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'acct-integrity');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await appRoleClient.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function createSaleWithJournalEntry() {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `ACCT-INTEG-${randomUUID().slice(0, 8)}`);
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 5 })
      .expect(201);
    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 2, unitPrice: 20 }], payments: [{ amount: 40 }] })
      .expect(201);
    const list = await request(app.getHttpServer()).get('/api/v1/accounting/journal-entries').set('Authorization', auth()).query({ sourceType: 'Sale', limit: 200 }).expect(200);
    const entry = list.body.data.find((e: { sourceId: string }) => e.sourceId === sale.body.data.id);
    return { sale: sale.body.data, entry };
  }

  describe('Double-entry integrity', () => {
    it('APPLICATION LAYER: AccountingEngineService.postEntry rejects an unbalanced set of lines before ever inserting anything', async () => {
      const prisma = app.get(PrismaService);
      const accounting = app.get(AccountingEngineService);
      const cash = await admin.account.findFirstOrThrow({ where: { businessId: biz.businessId, code: '1010' } });
      const revenue = await admin.account.findFirstOrThrow({ where: { businessId: biz.businessId, code: '4100' } });

      const beforeCount = await admin.journalEntry.count({ where: { businessId: biz.businessId } });

      await expect(
        prisma.withTenant(biz.businessId, (tx) =>
          accounting.postEntry(tx, {
            businessId: biz.businessId,
            entryDate: new Date(),
            sourceType: 'ManualTest',
            sourceId: randomUUID(),
            lines: [
              { accountId: cash.id, debit: 100 },
              { accountId: revenue.id, credit: 99 },
            ],
          }),
        ),
      ).rejects.toMatchObject({ code: 'UNBALANCED_JOURNAL_ENTRY' });

      const afterCount = await admin.journalEntry.count({ where: { businessId: biz.businessId } });
      expect(afterCount).toBe(beforeCount);
    });

    it('APPLICATION LAYER: rejects a line that is both a debit and a credit, or neither', async () => {
      const prisma = app.get(PrismaService);
      const accounting = app.get(AccountingEngineService);
      const cash = await admin.account.findFirstOrThrow({ where: { businessId: biz.businessId, code: '1010' } });
      const revenue = await admin.account.findFirstOrThrow({ where: { businessId: biz.businessId, code: '4100' } });

      await expect(
        prisma.withTenant(biz.businessId, (tx) =>
          accounting.postEntry(tx, {
            businessId: biz.businessId,
            entryDate: new Date(),
            sourceType: 'ManualTest',
            sourceId: randomUUID(),
            lines: [
              { accountId: cash.id, debit: 100, credit: 100 },
              { accountId: revenue.id, credit: 100 },
            ],
          }),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('DATABASE LAYER: the deferred constraint trigger rejects an unbalanced set of journal_entry_lines inserted directly via raw SQL as erp_app, bypassing the application layer entirely', async () => {
      const period = await admin.fiscalPeriod.findFirstOrThrow({ where: { businessId: biz.businessId, status: 'OPEN' } });
      const cash = await admin.account.findFirstOrThrow({ where: { businessId: biz.businessId, code: '1010' } });
      const revenue = await admin.account.findFirstOrThrow({ where: { businessId: biz.businessId, code: '4100' } });
      const entryId = randomUUID();

      // The trigger is DEFERRABLE INITIALLY DEFERRED (by design - it must
      // let postEntry insert a journal entry's lines one at a time within
      // one transaction, see the migration's own comment), so it normally
      // only fires at COMMIT. Prisma's interactive-transaction client
      // does not surface a COMMIT-time failure as a rejected promise in
      // this setup (verified directly: the same raw SQL run via plain
      // psql, and via this same Prisma transaction with an explicit `SET
      // CONSTRAINTS ALL IMMEDIATE` added, both correctly throw the exact
      // Postgres error below) - so this test forces the deferred check to
      // run immediately, inside the transaction, to observe it as a
      // catchable error. This is a Prisma client-library quirk in how
      // this particular test harness talks to Postgres, not a defect in
      // the trigger itself, which the direct-psql reproduction proves
      // unambiguously fires and rolls back the whole transaction either way.
      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
          await tx.$executeRawUnsafe(
            `INSERT INTO journal_entries (id, business_id, fiscal_period_id, entry_number, entry_date, status, source_type, source_id, created_at)
             VALUES ('${entryId}', '${biz.businessId}', '${period.id}', 'JE-RAWTEST1', NOW(), 'POSTED', 'RawTest', '${randomUUID()}', NOW())`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO journal_entry_lines (id, business_id, journal_entry_id, account_id, debit, credit, created_at)
             VALUES ('${randomUUID()}', '${biz.businessId}', '${entryId}', '${cash.id}', 100, 0, NOW())`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO journal_entry_lines (id, business_id, journal_entry_id, account_id, debit, credit, created_at)
             VALUES ('${randomUUID()}', '${biz.businessId}', '${entryId}', '${revenue.id}', 0, 90, NOW())`,
          );
          await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        }),
      ).rejects.toThrow(/not balanced/i);

      const orphanedEntry = await admin.journalEntry.findUnique({ where: { id: entryId } });
      expect(orphanedEntry).toBeNull();
    });
  });

  describe('Historical integrity / immutability', () => {
    it('DB LAYER: erp_app has no UPDATE or DELETE privilege on journal_entries or journal_entry_lines', async () => {
      const { entry } = await createSaleWithJournalEntry();

      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
          await tx.$executeRawUnsafe(`UPDATE journal_entries SET description = 'tampered' WHERE id = '${entry.id}'`);
        }),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
          await tx.$executeRawUnsafe(`DELETE FROM journal_entries WHERE id = '${entry.id}'`);
        }),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
          await tx.$executeRawUnsafe(`UPDATE journal_entry_lines SET debit = 999 WHERE journal_entry_id = '${entry.id}'`);
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it('REVERSAL: reverses a posted entry with swapped debit/credit lines, leaves the original completely untouched, and rejects a second reversal of the same entry', async () => {
      const { entry } = await createSaleWithJournalEntry();
      const originalLines = [...entry.lines].sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));

      const reversed = await request(app.getHttpServer())
        .post(`/api/v1/accounting/journal-entries/${entry.id}/reverse`)
        .set('Authorization', auth())
        .send({ reason: 'test reversal' })
        .expect(201);

      expect(reversed.body.data.reversalOfId).toBe(entry.id);
      const reversalLines = reversed.body.data.lines as { accountId: string; debit: string; credit: string }[];
      for (const original of entry.lines as { accountId: string; debit: string; credit: string }[]) {
        const mirror = reversalLines.find((l) => l.accountId === original.accountId);
        expect(mirror).toBeDefined();
        expect(Number(mirror!.debit)).toBeCloseTo(Number(original.credit), 4);
        expect(Number(mirror!.credit)).toBeCloseTo(Number(original.debit), 4);
      }

      // Reversal entry itself is balanced (it was built from an
      // already-balanced original with debit/credit swapped).
      const revTotalDebit = reversalLines.reduce((s, l) => s + Number(l.debit), 0);
      const revTotalCredit = reversalLines.reduce((s, l) => s + Number(l.credit), 0);
      expect(revTotalDebit).toBeCloseTo(revTotalCredit, 4);

      // The ORIGINAL entry's own lines are byte-for-byte unchanged.
      const refetched = await admin.journalEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { lines: true } });
      const refetchedLines = [...refetched.lines].sort((a, b) => a.id.localeCompare(b.id));
      expect(refetchedLines.length).toBe(originalLines.length);
      for (let i = 0; i < refetchedLines.length; i++) {
        expect(refetchedLines[i].debit.toString()).toBe(originalLines[i].debit.toString());
        expect(refetchedLines[i].credit.toString()).toBe(originalLines[i].credit.toString());
      }

      const secondReversal = await request(app.getHttpServer()).post(`/api/v1/accounting/journal-entries/${entry.id}/reverse`).set('Authorization', auth()).send({}).expect(422);
      expect(secondReversal.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('RLS / grants, tested live against Postgres', () => {
    it('all 5 Phase 6 tables have RLS + FORCE RLS enabled', async () => {
      const rows = await admin.$queryRawUnsafe<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('accounts','fiscal_periods','accounting_mapping_rules','journal_entries','journal_entry_lines')`,
      );
      expect(rows.length).toBe(5);
      for (const row of rows) {
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);
      }
    });

    it('erp_app grants match the documented design exactly', async () => {
      const rows = await admin.$queryRawUnsafe<{ table_name: string; privs: string }[]>(
        `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
         FROM information_schema.role_table_grants
         WHERE grantee = 'erp_app' AND table_name IN ('accounts','fiscal_periods','accounting_mapping_rules','journal_entries','journal_entry_lines')
         GROUP BY table_name`,
      );
      const byTable = Object.fromEntries(rows.map((r) => [r.table_name, r.privs]));
      expect(byTable['accounts']).toBe('INSERT,SELECT,UPDATE');
      expect(byTable['fiscal_periods']).toBe('INSERT,SELECT,UPDATE');
      expect(byTable['accounting_mapping_rules']).toBe('INSERT,SELECT');
      expect(byTable['journal_entries']).toBe('INSERT,SELECT');
      expect(byTable['journal_entry_lines']).toBe('INSERT,SELECT');
    });

    it('an unfiltered SELECT against accounts/journal_entries as erp_app with no tenant context returns zero rows', async () => {
      const accounts = await appRoleClient.$queryRawUnsafe<unknown[]>('SELECT * FROM accounts');
      expect(accounts.length).toBe(0);
      const entries = await appRoleClient.$queryRawUnsafe<unknown[]>('SELECT * FROM journal_entries');
      expect(entries.length).toBe(0);
    });

    it('SELECT ... FOR UPDATE against fiscal_periods succeeds as erp_app (the UPDATE grant supports locking, applying the Phase 5 lesson from day one)', async () => {
      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
          await tx.$queryRawUnsafe('SELECT id FROM fiscal_periods LIMIT 1 FOR UPDATE');
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('Tenant isolation', () => {
    it('tenant B cannot see tenant A accounts/journal entries via the API, and a cross-tenant INSERT is rejected by RLS WITH CHECK', async () => {
      const other = await registerAndLogin(app, 'acct-integrity-other');
      const { entry } = await createSaleWithJournalEntry();

      const list = await request(app.getHttpServer()).get('/api/v1/accounting/journal-entries').set('Authorization', `Bearer ${other.accessToken}`).expect(200);
      expect(list.body.data.find((e: { id: string }) => e.id === entry.id)).toBeUndefined();

      const get = await request(app.getHttpServer()).get(`/api/v1/accounting/journal-entries/${entry.id}`).set('Authorization', `Bearer ${other.accessToken}`).expect(404);
      expect(get.body.error.code).toBe('NOT_FOUND');

      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${other.businessId}'`);
          const period = await admin.fiscalPeriod.findFirstOrThrow({ where: { businessId: other.businessId, status: 'OPEN' } });
          await tx.$executeRawUnsafe(
            `INSERT INTO journal_entries (id, business_id, fiscal_period_id, entry_number, entry_date, status, source_type, source_id, created_at)
             VALUES ('${randomUUID()}', '${biz.businessId}', '${period.id}', 'JE-HACK0001', NOW(), 'POSTED', 'Hack', '${randomUUID()}', NOW())`,
          );
        }),
      ).rejects.toThrow();
    });
  });

  describe('Permissions', () => {
    it('a Cashier (no accounting.* permissions) is forbidden from every accounting route', async () => {
      const cashierRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'CASHIER' } });
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'Perm Cashier', email: `permcashier@${biz.slug}.test`, password: 'CashierPass1!', roleIds: [cashierRole.id] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `permcashier@${biz.slug}.test`, password: 'CashierPass1!', businessSlug: biz.slug })
        .expect(200);
      const cashierAuth = `Bearer ${login.body.data.accessToken}`;

      await request(app.getHttpServer()).get('/api/v1/accounting/accounts').set('Authorization', cashierAuth).expect(403);
      await request(app.getHttpServer()).get('/api/v1/accounting/journal-entries').set('Authorization', cashierAuth).expect(403);
      await request(app.getHttpServer()).get('/api/v1/accounting/journal-entries/trial-balance').set('Authorization', cashierAuth).expect(403);
      await request(app.getHttpServer()).post('/api/v1/accounting/periods').set('Authorization', cashierAuth).send({}).expect(403);
    });

    it('an Accountant can view the journal and reverse entries, but cannot reopen a closed period (not granted accounting.reopen_period by default)', async () => {
      const accountantRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'ACCOUNTANT' } });
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'Perm Accountant', email: `permaccountant@${biz.slug}.test`, password: 'AccountantPass1!', roleIds: [accountantRole.id] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `permaccountant@${biz.slug}.test`, password: 'AccountantPass1!', businessSlug: biz.slug })
        .expect(200);
      const accountantAuth = `Bearer ${login.body.data.accessToken}`;

      await request(app.getHttpServer()).get('/api/v1/accounting/journal-entries').set('Authorization', accountantAuth).expect(200);

      const { entry } = await createSaleWithJournalEntry();
      await request(app.getHttpServer()).post(`/api/v1/accounting/journal-entries/${entry.id}/reverse`).set('Authorization', accountantAuth).send({}).expect(201);

      // Uses the business's own bootstrap period (opening a NEW period
      // would overlap it, correctly rejected - see OpenPeriodUseCase).
      const openPeriod = await admin.fiscalPeriod.findFirstOrThrow({ where: { businessId: biz.businessId, status: 'OPEN' } });
      await request(app.getHttpServer()).post(`/api/v1/accounting/periods/${openPeriod.id}/close`).set('Authorization', accountantAuth).expect(200);
      await request(app.getHttpServer()).post(`/api/v1/accounting/periods/${openPeriod.id}/reopen`).set('Authorization', accountantAuth).expect(403);

      // The Business Owner DOES have accounting.reopen_period (spread of
      // every permission code) - reopen it so later tests in this file
      // (and other files sharing this suite run) aren't left without an
      // open period.
      await request(app.getHttpServer()).post(`/api/v1/accounting/periods/${openPeriod.id}/reopen`).set('Authorization', auth()).expect(200);
    });
  });
});
