import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 22 - the loyalty liability limitation, as an ENFORCED contract
 * rather than a paragraph someone might quietly delete.
 *
 * Approved decision (Option A, controlled pilot): the loyalty model is
 * NOT changed. Points are earned and redeemed entirely inside the
 * append-only CustomerPoints ledger; no journal entry is posted when a
 * point is earned, so unredeemed points are not carried as a General
 * Ledger liability. That is a real, material omission - a business with
 * a large outstanding point balance owes something the Balance Sheet
 * does not show - so the accepted price of not fixing it is saying so,
 * on every statement the omission touches.
 *
 * This spec therefore proves BOTH halves:
 *   1. the limitation is TRUE (points earn without a GL fact, and the
 *      outstanding balance really is measurable from the ledger), and
 *   2. the limitation is STATED (the text is present on the P&L, the
 *      Balance Sheet and the dashboard, and says the mandated thing).
 *
 * If someone later posts loyalty to the GL, (1) fails and the text must
 * be rewritten. If someone deletes the text, (2) fails. Either way the
 * report and its caveat cannot drift apart silently.
 */
describe('Reporting: the loyalty-points liability limitation (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let variantId: string;
  let customerId: string;

  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'loyalty-liability');

    // Earn 2 points per currency unit; each point redeems for 0.01.
    await setSetting('loyalty.points_per_currency_unit', 2);
    await setSetting('loyalty.currency_per_point', 0.01);

    ({ variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'LOY-LIAB-1'));
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 500, unitCost: 4 })
      .expect(201);

    const customer = await request(app.getHttpServer())
      .post('/api/v1/sales/customers')
      .set('Authorization', auth())
      .send({ name: 'Loyalty Liability Customer' })
      .expect(201);
    customerId = customer.body.data.id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function setSetting(key: string, value: unknown) {
    await request(app.getHttpServer()).put('/api/v1/settings').set('Authorization', auth()).send({ key, value }).expect(200);
  }

  function sell(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, ...body });
  }

  const get = (path: string) => request(app.getHttpServer()).get(path).set('Authorization', auth());

  /** The outstanding obligation, computed the way the limitation text
   *  says it can be: SUM(points) over the append-only ledger. */
  async function outstandingPoints() {
    const rows = await admin.customerPoints.findMany({ where: { businessId: biz.businessId } });
    return rows.reduce((s, r) => s.plus(r.points), D(0));
  }

  // ------------------------------------------------------------------
  describe('The limitation is TRUE: earning points posts no GL fact', () => {
    it('a sale that earns points writes the ledger row but no journal line changes because of it', async () => {
      const beforeLines = await admin.journalEntryLine.count({ where: { businessId: biz.businessId } });
      const beforePoints = await outstandingPoints();

      // 200.00 of merchandise -> 400 points earned at 2 points per unit.
      const res = await sell({
        customerId,
        items: [{ variantId, quantity: 10, unitPrice: 20 }],
        payments: [{ amount: 200 }],
      }).expect(201);

      const earned = await admin.customerPoints.findFirstOrThrow({
        where: { businessId: biz.businessId, referenceType: 'Sale', referenceId: res.body.data.id, type: 'EARN' },
      });
      expect(D(earned.points).toString()).toBe('400');
      expect((await outstandingPoints()).minus(beforePoints).toString()).toBe('400');

      // The sale posted journal lines - revenue, COGS, tender - but NONE
      // of them exists because points were earned: no journal entry in
      // this business names the loyalty ledger as its source at all.
      const afterLines = await admin.journalEntryLine.count({ where: { businessId: biz.businessId } });
      expect(afterLines).toBeGreaterThan(beforeLines);

      const loyaltySourced = await admin.journalEntry.count({
        where: { businessId: biz.businessId, sourceType: { in: ['CustomerPoints', 'Loyalty', 'LoyaltyPoints'] } },
      });
      expect(loyaltySourced).toBe(0);
    });

    it('no accounting mapping for loyalty exists, so a liability account cannot even be configured', async () => {
      const rules = await admin.accountingMappingRule.findMany({ where: { businessId: biz.businessId } });
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.some((r) => /LOYALTY|POINT/i.test(r.key))).toBe(false);
    });
  });

  describe('The limitation is TRUE: the omission is real and quantified', () => {
    it('outstanding points are measurable from the ledger and match the customer-facing balance', async () => {
      const outstanding = await outstandingPoints();
      expect(outstanding.greaterThan(0)).toBe(true);

      const res = await get(`/api/v1/sales/customers/${customerId}/points`).expect(200);
      // One customer holds every point in this business, so the
      // business-wide ledger sum and their reported balance agree.
      expect(D(res.body.data.balance).toString()).toBe(outstanding.toString());
    });

    it('the Balance Sheet excludes the redeemable value of those points, and still balances', async () => {
      const outstanding = await outstandingPoints();
      // What the business would owe if every point were redeemed today.
      const redeemableValue = outstanding.times('0.01');
      expect(redeemableValue.greaterThan(0)).toBe(true);

      const res = await get('/api/v1/reports/financial/balance-sheet').expect(200);
      const d = res.body.data;

      // No liability account carries the point obligation.
      const carriesPoints = d.liabilities.accounts.some(
        (a: { name: string; balance: string }) => /loyalt|point/i.test(a.name) || D(a.balance).equals(redeemableValue),
      );
      expect(carriesPoints).toBe(false);

      // And the omission is not an imbalance: the identity holds exactly
      // for what IS posted, which is precisely why the omission is
      // invisible without the written limitation below.
      expect(d.balanced).toBe(true);
      expect(Number(d.assets.total)).toBeCloseTo(Number(d.totalLiabilitiesAndEquity), 4);
    });

    it('redemption is recognised when it happens: it reduces revenue on the redeeming sale, not on the earning one', async () => {
      const before = await get('/api/v1/reports/financial/profit-and-loss').expect(200);
      const revenueBefore = D(before.body.data.netRevenue);

      // Redeem 400 points (worth 4.00) against a 100.00 basket.
      const res = await sell({
        customerId,
        items: [{ variantId, quantity: 5, unitPrice: 20 }],
        redeemPoints: 400,
        payments: [{ amount: 96 }],
      }).expect(201);
      expect(D(res.body.data.discountAmount).greaterThanOrEqualTo(4)).toBe(true);

      const after = await get('/api/v1/reports/financial/profit-and-loss').expect(200);
      const delta = D(after.body.data.netRevenue).minus(revenueBefore);

      // The sale grossed 100.00; 4.00 of it was settled in points, so
      // recognised revenue is 96.00 - the redemption landed in THIS
      // period, while the earning that funded it landed in the earlier
      // one with no accrual in between. That gap is the timing mismatch
      // the P&L limitation describes.
      expect(delta.toString()).toBe('96');
    });
  });

  describe('The limitation is STATED, verbatim, on every statement it touches', () => {
    /** The sentence the approved decision requires, in whatever wording
     *  each statement uses: measurable through the ledger, NOT a GL
     *  liability, and explicitly scoped to the controlled pilot. */
    function assertMandatedStatement(text: string) {
      expect(typeof text).toBe('string');
      expect(text).toMatch(/CustomerPoints ledger/);
      expect(text).toMatch(/NOT represented as a General Ledger liability/);
      expect(text).toMatch(/controlled pilot/i);
      expect(text).toMatch(/measurable/i);
    }

    it('Balance Sheet: states that outstanding points are measurable but are not a GL liability', async () => {
      const res = await get('/api/v1/reports/financial/balance-sheet').expect(200);
      assertMandatedStatement(res.body.limitations.loyaltyPoints);
      // It must also say WHY the statement still balances, so a reader
      // does not take `balanced: true` as proof of completeness.
      expect(res.body.limitations.loyaltyPoints).toMatch(/omitted obligation, not an imbalance/i);
    });

    it('P&L: states the earn/redeem timing mismatch alongside the same liability statement', async () => {
      const res = await get('/api/v1/reports/financial/profit-and-loss').expect(200);
      assertMandatedStatement(res.body.limitations.loyaltyPoints);
      expect(res.body.limitations.loyaltyPoints).toMatch(/recognised on REDEMPTION, not on earning/i);
      expect(res.body.limitations.loyaltyPoints).toMatch(/timing mismatch/i);
    });

    it('Dashboard: carries it too, because its netRevenue and netProfit inherit the same treatment', async () => {
      const res = await get('/api/v1/reports/dashboard').expect(200);
      assertMandatedStatement(res.body.limitations.loyaltyPoints);
    });

    it('adding it did not displace the limitations that were already there', async () => {
      const pl = await get('/api/v1/reports/financial/profit-and-loss').expect(200);
      expect(Object.keys(pl.body.limitations)).toEqual(
        expect.arrayContaining(['revenueBasis', 'operatingExpensesScope', 'discounts', 'walkInReturns', 'loyaltyPoints']),
      );

      const bs = await get('/api/v1/reports/financial/balance-sheet').expect(200);
      expect(Object.keys(bs.body.limitations)).toEqual(
        expect.arrayContaining(['currentPeriodEarnings', 'expenseScope', 'loyaltyPoints']),
      );

      const dash = await get('/api/v1/reports/dashboard').expect(200);
      expect(Object.keys(dash.body.limitations)).toEqual(
        expect.arrayContaining(['expenses', 'netProfit', 'cashAndBank', 'lowStock', 'loyaltyPoints']),
      );
    });
  });
});
