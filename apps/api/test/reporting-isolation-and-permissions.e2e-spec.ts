import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';
import { registerAndLogin } from './utils/register-and-login';

/**
 * Phase 7A deliberately proves the GUARDRAILS before any report content
 * exists: tenant isolation, the new server-side branch scoping, route
 * permission boundaries, and server-side cost/profit field omission.
 * A reporting layer that leaked across tenants or exposed profit to a
 * Cashier would be a security defect, so these are tested first, against
 * real PostgreSQL - never mocks.
 */
describe('Reporting: tenant isolation, branch scoping, permissions, field omission (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let variantId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'reporting-guard');

    ({ variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RPT-GUARD-1'));
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 50, unitCost: 4 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 5, unitPrice: 20 }], payments: [{ amount: 100 }] })
      .expect(201);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  function auth() {
    return `Bearer ${biz.accessToken}`;
  }

  async function loginAs(roleName: string, emailPrefix: string, branchIds: string[] = []) {
    const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: roleName } });
    const email = `${emailPrefix}@${biz.slug}.test`;
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: emailPrefix, email, password: 'RoleUserPass1!', roleIds: [role.id], branchIds })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'RoleUserPass1!', businessSlug: biz.slug })
      .expect(200);
    return `Bearer ${login.body.data.accessToken}`;
  }

  describe('Permission boundaries', () => {
    it('a CASHIER is forbidden from every reporting route - POS access grants no reporting or financial visibility', async () => {
      const cashierAuth = await loginAs('CASHIER', 'rptcashier');
      await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', cashierAuth).expect(403);
    });

    it('a SALES_EMPLOYEE is forbidden from reporting routes', async () => {
      const seAuth = await loginAs('SALES_EMPLOYEE', 'rptsalesemp');
      await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', seAuth).expect(403);
    });

    it('an ACCOUNTANT and the BUSINESS_OWNER can read sales reports', async () => {
      const accountantAuth = await loginAs('ACCOUNTANT', 'rptaccountant');
      await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', accountantAuth).expect(200);
      await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', auth()).expect(200);
    });
  });

  describe('Server-side cost/profit field omission', () => {
    it('an Owner sees cogs and grossProfit; a BRANCH_MANAGER (no view_cost, no view_profit) has those keys ABSENT, not null', async () => {
      const ownerRes = await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', auth()).expect(200);
      expect(ownerRes.body.data).toHaveProperty('cogs');
      expect(ownerRes.body.data).toHaveProperty('grossProfit');

      const bmAuth = await loginAs('BRANCH_MANAGER', 'rptbranchmgr', [biz.branchId]);
      const bmRes = await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', bmAuth).expect(200);
      // Non-sensitive operational figures remain visible...
      expect(bmRes.body.data).toHaveProperty('netSales');
      expect(bmRes.body.data).toHaveProperty('transactionCount');
      // ...but cost/profit keys are genuinely removed, not nulled.
      expect(bmRes.body.data).not.toHaveProperty('cogs');
      expect(bmRes.body.data).not.toHaveProperty('grossProfit');
      expect(Object.keys(bmRes.body.data)).not.toContain('grossProfit');
    });
  });

  describe('Branch scoping (new in Phase 7, server-side enforced)', () => {
    it('a BRANCH_MANAGER assigned to a branch sees that branch data; assigned to NO branch they see nothing (fail closed, never everything)', async () => {
      const assignedAuth = await loginAs('BRANCH_MANAGER', 'rptbm-assigned', [biz.branchId]);
      const assigned = await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', assignedAuth).expect(200);
      expect(Number(assigned.body.data.transactionCount)).toBeGreaterThan(0);

      // No UserBranch rows at all -> empty allow-list -> zero rows.
      const unassignedAuth = await loginAs('BRANCH_MANAGER', 'rptbm-unassigned', []);
      const unassigned = await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', unassignedAuth).expect(200);
      expect(Number(unassigned.body.data.transactionCount)).toBe(0);
      expect(Number(unassigned.body.data.netSales)).toBe(0);
    });

    it('a BRANCH_MANAGER passing a branchId they are NOT assigned to is REJECTED (403), not silently given an empty result', async () => {
      const otherBranch = await request(app.getHttpServer())
        .post('/api/v1/branches')
        .set('Authorization', auth())
        .send({ name: 'Reporting Guard Second Branch' })
        .expect(201);

      const bmAuth = await loginAs('BRANCH_MANAGER', 'rptbm-probe', [biz.branchId]);
      const forbidden = await request(app.getHttpServer())
        .get('/api/v1/reports/sales/summary')
        .query({ branchId: otherBranch.body.data.id })
        .set('Authorization', bmAuth)
        .expect(403);
      expect(forbidden.body.error.code).toBe('FORBIDDEN');

      // The branch they ARE assigned to still works.
      await request(app.getHttpServer())
        .get('/api/v1/reports/sales/summary')
        .query({ branchId: biz.branchId })
        .set('Authorization', bmAuth)
        .expect(200);
    });

    it('an Owner (reports.financial.view) is NOT branch-restricted and may filter to any branch of their own business', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/sales/summary')
        .query({ branchId: biz.branchId })
        .set('Authorization', auth())
        .expect(200);
      expect(Number(res.body.data.transactionCount)).toBeGreaterThan(0);
    });

    it('a branchId belonging to ANOTHER TENANT is rejected as not-found, never leaking whether it exists', async () => {
      const other = await registerAndLogin(app, 'reporting-guard-other');
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/sales/summary')
        .query({ branchId: other.branchId })
        .set('Authorization', auth())
        .expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Tenant isolation', () => {
    it("tenant B's report never contains tenant A's sales, even though both use the same endpoint", async () => {
      const other = await registerAndLogin(app, 'reporting-iso-other');
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/sales/summary')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(200);
      // Tenant B has made no sales at all - if RLS or the tenant predicate
      // leaked, A's sale would show up here.
      expect(Number(res.body.data.transactionCount)).toBe(0);
      expect(Number(res.body.data.netSales)).toBe(0);

      const mine = await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', auth()).expect(200);
      expect(Number(mine.body.data.transactionCount)).toBeGreaterThan(0);
    });
  });

  describe('Date range validation', () => {
    it('rejects from > to rather than silently returning an empty period', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/sales/summary')
        .query({ from: '2026-06-01', to: '2026-01-01' })
        .set('Authorization', auth())
        .expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('returns a structurally valid zeroed report for a period with no data, not an error', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/sales/summary')
        .query({ from: '2001-01-01', to: '2001-01-31' })
        .set('Authorization', auth())
        .expect(200);
      expect(Number(res.body.data.transactionCount)).toBe(0);
      expect(Number(res.body.data.netSales)).toBe(0);
      expect(res.body.range.timezone).toBeTruthy();
    });

    it('resolves the window in the BUSINESS timezone and reports the range it actually used', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/reports/sales/summary').set('Authorization', auth()).expect(200);
      expect(res.body.range.timezone).toBe('Africa/Cairo');
      // `to` is exclusive server-side, so it must be strictly after `from`.
      expect(new Date(res.body.range.to).getTime()).toBeGreaterThan(new Date(res.body.range.from).getTime());
    });
  });
});
