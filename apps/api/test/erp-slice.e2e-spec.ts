import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { ROLE_TEMPLATE_PERMISSIONS } from '@retail/shared-types';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 13 - ERP WEB, FIRST VERTICAL SLICE.
 *
 * WHAT THIS SPEC IS FOR. The ERP web app added no backend code: the three
 * contracts it consumes already existed, and re-verifying them was the
 * first thing this milestone did. What did NOT exist was proof that those
 * contracts BEHAVE AS THE ERP DEPENDS ON THEM TO for the roles the ERP is
 * actually built for - a back office is not a till, and every previous
 * warranty and shift test ran as the business owner, who holds every
 * permission that exists and therefore cannot demonstrate a boundary.
 *
 * So each case below is a claim the ERP UI makes, proved against a real
 * app and real PostgreSQL under RLS with the restricted `erp_app` role:
 *
 *   - navigation is a function of grants, and the grants differ by role;
 *   - the dashboard DELETES cost and profit keys rather than nulling them,
 *     so a BRANCH_MANAGER's browser never receives a figure to hide;
 *   - resolving a claim is `warranty.claim`, which an ACCOUNTANT lacks;
 *   - reconciling a shift is `shifts.reconcile`, and the figures on that
 *     screen are `shifts.view_expected`;
 *   - both write paths return the AUTHORITATIVE record, refuse a second
 *     attempt, and are invisible across a tenant boundary.
 *
 * The roles are read from the LIVE templates (`ROLE_TEMPLATE_PERMISSIONS`)
 * rather than asserted from memory, so a change to the matrix that would
 * change the ERP's navigation fails here.
 */
describe('ERP first vertical slice (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let other: SalesFixture;

  /** Tokens for the four roles the ERP is built for, plus the owner. */
  let ownerToken: string;
  let managerToken: string;
  let accountantToken: string;
  let inventoryToken: string;

  let warrantyId: string;
  let openClaimId: string;
  let closedShiftId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    biz = await setupSalesFixture(app, 'erp-a');
    other = await setupSalesFixture(app, 'erp-b');
    ownerToken = biz.accessToken;

    managerToken = await userWithRole('BRANCH_MANAGER', 'manager');
    accountantToken = await userWithRole('ACCOUNTANT', 'accountant');
    inventoryToken = await userWithRole('INVENTORY_MANAGER', 'stock');

    // --- a sold serial-tracked unit, covered, and claimed against ---
    const { variantId } = await createSimpleProduct(app, ownerToken, biz.uomId, 'ERP-SER-1', {
      tracksSerialNumbers: true,
      defaultCost: 100,
      defaultSellingPrice: 300,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', bearer(ownerToken))
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 2, unitCost: 100, serials: ['ERP-SN-1', 'ERP-SN-2'] })
      .expect(201);

    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', bearer(ownerToken))
      .send({
        warehouseId: biz.warehouseId,
        items: [{ variantId, quantity: 2, unitPrice: 300, serials: ['ERP-SN-1', 'ERP-SN-2'] }],
        payments: [{ amount: 600, method: 'CASH' }],
      })
      .expect(201);
    const saleItemId: string = sale.body.data.items[0].id;

    const serial = await admin.serialNumber.findFirstOrThrow({
      where: { businessId: biz.businessId, serial: 'ERP-SN-1' },
    });

    const registered = await request(app.getHttpServer())
      .post('/api/v1/warranties')
      .set('Authorization', bearer(ownerToken))
      .send({ saleItemId, serialNumberId: serial.id, durationDays: 365 })
      .expect(201);
    warrantyId = registered.body.data.id;

    const claim = await request(app.getHttpServer())
      .post(`/api/v1/warranties/${warrantyId}/claims`)
      .set('Authorization', bearer(ownerToken))
      .send({ description: 'Zip fails after two weeks' })
      .expect(201);
    openClaimId = claim.body.data.id;

    // --- a closed, unreconciled shift with a real variance ---
    // The fixture's shift took 600 in cash on a 0 float, so the documents
    // say 600. The cashier counts 590: a 10 shortage for someone to
    // acknowledge, which is the whole point of the reconciliation screen.
    await request(app.getHttpServer())
      .post('/api/v1/sales/shifts/close')
      .set('Authorization', bearer(ownerToken))
      .send({ countedCash: 590 })
      .expect(200);
    closedShiftId = biz.activeShiftId;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  function bearer(token: string) {
    return `Bearer ${token}`;
  }

  /** Money crosses the wire as a decimal STRING (`Decimal#toJSON`), which
   *  trims trailing zeros — `590`, not `590.0000`. Assert the value and
   *  the fact that it IS a string, not one particular rendering of it. */
  function money(actual: unknown): number {
    expect(typeof actual).toBe('string');
    return Number(actual);
  }

  /** Creates a user on one of the built-in role templates and logs them in.
   *  The role's grants are the seeded template's, so these tokens carry the
   *  real matrix rather than a set invented by this spec. */
  async function userWithRole(template: string, handle: string): Promise<string> {
    const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: template } });
    const email = `${handle}@${biz.slug}.test`;
    const password = 'ErpUserPass1!';
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', bearer(biz.accessToken))
      .send({ name: handle, email, password, roleIds: [role.id] })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, businessSlug: biz.slug })
      .expect(200);
    return login.body.data.accessToken;
  }

  // ================================================================
  // 1. Session and effective permissions - the ERP's foundation
  // ================================================================
  describe('authentication and effective permissions', () => {
    it('an ERP role signs in against the SAME auth contract the POS uses', async () => {
      // There is deliberately no second authentication model: the ERP web
      // app posts to the same /auth/login and reads the same token pair.
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `accountant@${biz.slug}.test`, password: 'ErpUserPass1!', businessSlug: biz.slug })
        .expect(200);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).toEqual(expect.any(String));
      expect(res.body.data.user.email).toBe(`accountant@${biz.slug}.test`);
    });

    it('GET /permissions/me returns each role a DIFFERENT set — which is what draws the nav', async () => {
      const codes = async (token: string) =>
        (await request(app.getHttpServer()).get('/api/v1/permissions/me').set('Authorization', bearer(token)).expect(200)).body
          .data.permissions as string[];

      const [manager, accountant, stock] = await Promise.all([
        codes(managerToken),
        codes(accountantToken),
        codes(inventoryToken),
      ]);

      // The three grants the ERP navigation asks about.
      const nav = (p: string[]) => ({
        dashboard: p.includes('reports.dashboard.view'),
        warranty: p.includes('warranty.view'),
        shifts: p.includes('shifts.view'),
      });
      expect(nav(manager)).toEqual({ dashboard: true, warranty: true, shifts: true });
      expect(nav(accountant)).toEqual({ dashboard: true, warranty: true, shifts: true });
      // An INVENTORY_MANAGER reaches none of this milestone's three
      // destinations, which is why the app has a /no-access screen rather
      // than an empty shell.
      expect(nav(stock)).toEqual({ dashboard: false, warranty: false, shifts: false });

      // And the CONTROLS differ where the screens do not: an accountant
      // reconciles but may not decide a warranty claim.
      expect(accountant).toContain('shifts.reconcile');
      expect(accountant).not.toContain('warranty.claim');
      expect(manager).toContain('warranty.claim');
    });

    it('the live role templates still match what the ERP navigation assumes', async () => {
      // If this fails, the nav map in `apps/erp-web/src/lib/navigation.ts`
      // is describing a matrix that no longer exists.
      expect(ROLE_TEMPLATE_PERMISSIONS.INVENTORY_MANAGER).not.toContain('reports.dashboard.view');
      expect(ROLE_TEMPLATE_PERMISSIONS.INVENTORY_MANAGER).not.toContain('warranty.view');
      expect(ROLE_TEMPLATE_PERMISSIONS.INVENTORY_MANAGER).not.toContain('shifts.view');
      expect(ROLE_TEMPLATE_PERMISSIONS.ACCOUNTANT).not.toContain('warranty.claim');
      expect(ROLE_TEMPLATE_PERMISSIONS.BRANCH_MANAGER).not.toContain('products.view_cost');
      expect(ROLE_TEMPLATE_PERMISSIONS.BRANCH_MANAGER).not.toContain('reports.view_profit');
    });
  });

  // ================================================================
  // 2. Dashboard
  // ================================================================
  describe('dashboard', () => {
    it('serves the shape the ERP dashboard renders, with the server’s own limitations text', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/dashboard')
        .set('Authorization', bearer(ownerToken))
        .expect(200);

      expect(res.body.data.kpis).toEqual(
        expect.objectContaining({
          sales: expect.any(String),
          netSales: expect.any(String),
          transactions: expect.any(Number),
          receivables: expect.any(String),
          cashBalance: expect.any(String),
        }),
      );
      expect(Array.isArray(res.body.data.topProducts)).toBe(true);
      expect(Array.isArray(res.body.data.slowestProducts)).toBe(true);
      // Printed verbatim by the ERP rather than paraphrased into
      // reassuring copy.
      expect(Object.keys(res.body.limitations).length).toBeGreaterThan(0);
      expect(res.body.range).toEqual(
        expect.objectContaining({ from: expect.any(String), to: expect.any(String), timezone: expect.any(String) }),
      );
    });

    it('DELETES cost and profit for a BRANCH_MANAGER rather than nulling them', async () => {
      // This is the entire permission model of the ERP dashboard. The
      // browser renders "what arrived"; if the server merely nulled these,
      // a client-side branch would be the only thing standing between a
      // branch manager and the shop's margin.
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/dashboard')
        .set('Authorization', bearer(managerToken))
        .expect(200);

      for (const key of ['totalCost', 'cogs', 'inventoryValue', 'grossProfit', 'netProfit']) {
        expect(res.body.data.kpis).not.toHaveProperty(key);
      }
      for (const row of [...res.body.data.topProducts, ...res.body.data.slowestProducts]) {
        expect(row).not.toHaveProperty('profit');
        expect(row).not.toHaveProperty('marginPercent');
      }
      // The figures they DO hold are untouched.
      expect(res.body.data.kpis.sales).toEqual(expect.any(String));
    });

    it('SENDS cost and profit to an ACCOUNTANT, who holds both grants', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/dashboard')
        .set('Authorization', bearer(accountantToken))
        .expect(200);

      for (const key of ['totalCost', 'cogs', 'inventoryValue']) {
        expect(res.body.data.kpis).toHaveProperty(key);
      }
      for (const key of ['grossProfit', 'netProfit']) {
        expect(res.body.data.kpis).toHaveProperty(key);
      }
    });

    it('refuses an INVENTORY_MANAGER outright — the route is guarded, not just hidden', async () => {
      // Hiding a nav entry is UX. This is the authorization.
      await request(app.getHttpServer())
        .get('/api/v1/reports/dashboard')
        .set('Authorization', bearer(inventoryToken))
        .expect(403);
    });
  });

  // ================================================================
  // 3. Warranty claim resolution
  // ================================================================
  describe('warranty claim resolution', () => {
    it('lists claimed warranties with the SERVER-DERIVED effective status the ERP displays', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/warranties?status=CLAIMED')
        .set('Authorization', bearer(managerToken))
        .expect(200);

      const row = res.body.data.find((w: { id: string }) => w.id === warrantyId);
      expect(row).toBeDefined();
      // `effectiveStatus` is what the screen renders; the browser never
      // compares a date against its own clock.
      expect(row.effectiveStatus).toBe('CLAIMED');
      expect(row.serialNumber.serial).toBe('ERP-SN-1');
      expect(row.saleItem.sale.saleNumber).toEqual(expect.any(String));
      expect(row.claimCount).toBeGreaterThanOrEqual(1);
    });

    it('lets an ACCOUNTANT READ the claim history they audit', async () => {
      // `warranty.view` gates the screen; `warranty.claim` gates the
      // control. Conflating the two would hide claim history from the
      // people whose job is to audit it.
      const res = await request(app.getHttpServer())
        .get(`/api/v1/warranties/${warrantyId}`)
        .set('Authorization', bearer(accountantToken))
        .expect(200);
      expect(res.body.data.claims.map((c: { id: string }) => c.id)).toContain(openClaimId);
    });

    it('REFUSES an accountant the resolution itself (403 on warranty.claim)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${warrantyId}/claims/${openClaimId}/resolve`)
        .set('Authorization', bearer(accountantToken))
        .send({ status: 'RESOLVED', resolution: 'Repaired under cover' })
        .expect(403);

      // And the claim is untouched — a refused request records nothing.
      const claim = await admin.warrantyClaim.findUniqueOrThrow({ where: { id: openClaimId } });
      expect(claim.status).toBe('OPEN');
      expect(claim.resolvedAt).toBeNull();
    });

    it('resolves for a BRANCH_MANAGER and returns the AUTHORITATIVE record', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/warranties/${warrantyId}/claims/${openClaimId}/resolve`)
        .set('Authorization', bearer(managerToken))
        .send({ status: 'RESOLVED', resolution: 'Zip replaced, unit returned to customer' })
        .expect(200);

      // What the ERP renders as the result: the server's status, its
      // timestamp, its text — nothing assumed from what was submitted.
      expect(res.body.data.status).toBe('RESOLVED');
      expect(res.body.data.resolvedAt).toEqual(expect.any(String));
      expect(res.body.data.resolution).toBe('Zip replaced, unit returned to customer');
      expect(res.body.data.resolvedBy).toEqual(expect.any(String));

      const stored = await admin.warrantyClaim.findUniqueOrThrow({ where: { id: openClaimId } });
      expect(stored.status).toBe('RESOLVED');
    });

    it('refuses a SECOND resolution of the same claim with a 409', async () => {
      // The ERP hides the control once a claim is decided, but that is UX;
      // this is what makes a stale tab safe.
      const res = await request(app.getHttpServer())
        .post(`/api/v1/warranties/${warrantyId}/claims/${openClaimId}/resolve`)
        .set('Authorization', bearer(managerToken))
        .send({ status: 'REJECTED' })
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');

      // The first decision stands.
      const stored = await admin.warrantyClaim.findUniqueOrThrow({ where: { id: openClaimId } });
      expect(stored.status).toBe('RESOLVED');
      expect(stored.resolution).toBe('Zip replaced, unit returned to customer');
    });

    it('accepts ONLY the two outcomes the ERP offers', async () => {
      const second = await request(app.getHttpServer())
        .post(`/api/v1/warranties/${warrantyId}/claims`)
        .set('Authorization', bearer(ownerToken))
        .send({ description: 'Second fault' })
        .expect(201);

      // There is deliberately no path back to OPEN and no third status,
      // which is why the ERP's dropdown has exactly two options.
      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${warrantyId}/claims/${second.body.data.id}/resolve`)
        .set('Authorization', bearer(managerToken))
        .send({ status: 'OPEN' })
        .expect(422);

      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${warrantyId}/claims/${second.body.data.id}/resolve`)
        .set('Authorization', bearer(managerToken))
        .send({ status: 'REJECTED', resolution: 'Impact damage, not a defect' })
        .expect(200);
    });

    it('is invisible across a tenant boundary', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/warranties/${warrantyId}`)
        .set('Authorization', bearer(other.accessToken))
        .expect(404);

      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${warrantyId}/claims/${openClaimId}/resolve`)
        .set('Authorization', bearer(other.accessToken))
        .send({ status: 'REJECTED' })
        .expect(404);
    });
  });

  // ================================================================
  // 4. Shift reconciliation
  // ================================================================
  describe('shift reconciliation', () => {
    it('lists the closed shift with the figures a reconciler is entitled to', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/sales/shifts')
        .set('Authorization', bearer(managerToken))
        .expect(200);

      const row = res.body.data.find((s: { id: string }) => s.id === closedShiftId);
      expect(row).toBeDefined();
      expect(row.status).toBe('CLOSED');
      expect(row.reconciledAt).toBeNull();
      expect(money(row.countedCash)).toBe(590);
      // A BRANCH_MANAGER holds `shifts.view_expected`, so the figures the
      // reconciliation screen shows genuinely arrive.
      expect(money(row.expectedCash)).toBe(600);
      expect(money(row.variance)).toBe(-10);
    });

    it('the variance the ERP labels a SHORTAGE is the server’s own figure', async () => {
      // The ERP classifies the SIGN of this number and computes nothing:
      // expected cash is openingFloat + SUM(cash_transactions), derived
      // server-side, and there is deliberately no second implementation in
      // the browser that could drift from it.
      const shift = await admin.shift.findUniqueOrThrow({ where: { id: closedShiftId } });
      expect(Number(shift.countedCash)).toBe(590);
      const movements = await admin.cashTransaction.aggregate({
        where: { shiftId: closedShiftId },
        _sum: { amount: true },
      });
      const expected = Number(shift.openingFloat) + Number(movements._sum.amount ?? 0);
      expect(expected).toBe(600);
      expect(590 - expected).toBe(-10);
    });

    it('REFUSES reconciliation to a role without shifts.reconcile', async () => {
      // A cashier is the case that matters: they closed this drawer blind
      // and must not sign off their own variance.
      const cashierRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'CASHIER' } });
      const email = `till@${biz.slug}.test`;
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', bearer(ownerToken))
        .send({ name: 'Till User', email, password: 'ErpUserPass1!', roleIds: [cashierRole.id] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'ErpUserPass1!', businessSlug: biz.slug })
        .expect(200);
      const cashierToken = login.body.data.accessToken;

      await request(app.getHttpServer())
        .post(`/api/v1/sales/shifts/${closedShiftId}/reconcile`)
        .set('Authorization', bearer(cashierToken))
        .send({ note: 'Looks fine to me' })
        .expect(403);

      // And they are not sent the figures either — the blind close rule
      // outlives the close itself.
      const list = await request(app.getHttpServer())
        .get('/api/v1/sales/shifts')
        .set('Authorization', bearer(cashierToken))
        .expect(200);
      const row = list.body.data.find((s: { id: string }) => s.id === closedShiftId);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('expectedCash');
      expect(row).not.toHaveProperty('variance');
      // What they counted is theirs to see; what it should have been is not.
      expect(money(row.countedCash)).toBe(590);

      const stored = await admin.shift.findUniqueOrThrow({ where: { id: closedShiftId } });
      expect(stored.reconciledAt).toBeNull();
    });

    it('reconciles for an ACCOUNTANT and returns the AUTHORITATIVE shift', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/sales/shifts/${closedShiftId}/reconcile`)
        .set('Authorization', bearer(accountantToken))
        .send({ note: 'Ten short; till float error, accepted' })
        .expect(200);

      expect(res.body.data.reconciledAt).toEqual(expect.any(String));
      expect(res.body.data.reconciledBy).toEqual(expect.any(String));
      expect(res.body.data.reconciliationNote).toBe('Ten short; till float error, accepted');
      // RECONCILIATION IS AN ACKNOWLEDGEMENT, NOT A CORRECTION: the
      // cashier's counted figure and the server's variance are exactly
      // what they were before the sign-off.
      expect(money(res.body.data.countedCash)).toBe(590);
      expect(money(res.body.data.expectedCash)).toBe(600);
      expect(money(res.body.data.variance)).toBe(-10);
    });

    it('leaves the counted amount immutable — there is no field that could change it', async () => {
      const stored = await admin.shift.findUniqueOrThrow({ where: { id: closedShiftId } });
      expect(Number(stored.countedCash)).toBe(590);
      expect(stored.status).toBe('CLOSED');
    });

    it('refuses a SECOND reconciliation with a 409', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/sales/shifts/${closedShiftId}/reconcile`)
        .set('Authorization', bearer(managerToken))
        .send({ note: 'Signing off again' })
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');

      // The first sign-off, and its author, stand.
      const stored = await admin.shift.findUniqueOrThrow({ where: { id: closedShiftId } });
      expect(stored.reconciliationNote).toBe('Ten short; till float error, accepted');
    });

    it('refuses to reconcile a shift that is still OPEN', async () => {
      const registers = await request(app.getHttpServer())
        .get('/api/v1/cash-registers')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      const opened = await request(app.getHttpServer())
        .post('/api/v1/sales/shifts/open')
        .set('Authorization', bearer(ownerToken))
        .send({ warehouseId: biz.warehouseId, cashRegisterId: registers.body.data[0].id, openingFloat: 50 })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/sales/shifts/${opened.body.data.id}/reconcile`)
        .set('Authorization', bearer(managerToken))
        .send({})
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('is invisible across a tenant boundary', async () => {
      // Another tenant's shift list does not contain it...
      const list = await request(app.getHttpServer())
        .get('/api/v1/sales/shifts')
        .set('Authorization', bearer(other.accessToken))
        .expect(200);
      expect(list.body.data.find((s: { id: string }) => s.id === closedShiftId)).toBeUndefined();

      // ...and naming it directly reconciles nothing.
      await request(app.getHttpServer())
        .post(`/api/v1/sales/shifts/${closedShiftId}/reconcile`)
        .set('Authorization', bearer(other.accessToken))
        .send({ note: 'Not mine' })
        .expect(404);
    });
  });
});
