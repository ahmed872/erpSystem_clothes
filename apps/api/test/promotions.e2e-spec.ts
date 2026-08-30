import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';

/**
 * Phase 8D - Promotions. Real NestJS app + real PostgreSQL with RLS and
 * FORCE RLS active. No mocks: append-only provenance, tenant isolation,
 * permission boundaries and historical immutability are integrity
 * invariants a mock cannot prove.
 */
describe('Promotions (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let other: SalesFixture;

  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
  const YESTERDAY = '2020-01-01';
  const FAR_FUTURE = '2099-12-31';
  let seq = 0;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'promo-a');
    other = await setupSalesFixture(app, 'promo-b');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function createCustomer(name: string, token = auth()) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales/customers')
      .set('Authorization', token)
      .send({ name })
      .expect(201);
    return res.body.data.id as string;
  }

  async function createCategory(name: string, token = auth()) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', token)
      .send({ name })
      .expect(201);
    return res.body.data.id as string;
  }

  /** A product (optionally in a category) with stock, returning its ids. */
  async function stocked(sku: string, opts: { categoryId?: string; qty?: number; token?: string; fixture?: SalesFixture } = {}) {
    const token = opts.token ?? biz.accessToken;
    const fixture = opts.fixture ?? biz;
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sku,
        name: sku,
        baseUomId: fixture.uomId,
        categoryId: opts.categoryId,
        defaultCost: 1,
        defaultSellingPrice: 100,
      })
      .expect(201);
    const productId = res.body.data.id as string;
    const variantId = res.body.data.variants[0].id as string;
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', `Bearer ${token}`)
      .send({ warehouseId: fixture.warehouseId, variantId, quantity: opts.qty ?? 500, unitCost: 1 })
      .expect(201);
    return { productId, variantId };
  }

  function createPromotion(body: Record<string, unknown>, token = auth()) {
    return request(app.getHttpServer())
      .post('/api/v1/promotions')
      .set('Authorization', token)
      .send({ validFrom: YESTERDAY, validTo: FAR_FUTURE, ...body });
  }

  function sell(body: Record<string, unknown>, token = auth(), fixture = biz) {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', token)
      .send({ warehouseId: fixture.warehouseId, ...body });
  }

  async function saleRow(id: string) {
    return admin.sale.findUniqueOrThrow({ where: { id }, include: { items: true } });
  }

  async function applicationsFor(saleId: string) {
    return admin.salePromotionApplication.findMany({ where: { saleId }, orderBy: { createdAt: 'asc' } });
  }

  // ------------------------------------------------------------------
  describe('CRUD, validation and target resolution', () => {
    it('creates each of the three approved types and rejects anything else', async () => {
      const { variantId } = await stocked(`PR-CRUD-${seq++}`);
      const pct = await createPromotion({ name: 'Ten off', type: 'PERCENTAGE', percentageValue: 10, targetType: 'VARIANT', targetId: variantId }).expect(201);
      expect(pct.body.data.percentageValue).toBe('10');
      expect(pct.body.data.fixedAmount).toBeNull();

      await createPromotion({ name: 'Fiver', type: 'FIXED_AMOUNT', fixedAmount: 5, targetType: 'VARIANT', targetId: variantId }).expect(201);
      await createPromotion({ name: 'B2G1', type: 'BUY_X_GET_Y', buyQuantity: 2, getQuantity: 1, targetType: 'VARIANT', targetId: variantId }).expect(201);

      await createPromotion({ name: 'Nope', type: 'THRESHOLD', targetType: 'VARIANT', targetId: variantId }).expect(422);
      // Basket-wide targets are deferred and must not be accepted.
      await createPromotion({ name: 'Nope', type: 'PERCENTAGE', percentageValue: 10, targetType: 'BASKET', targetId: variantId }).expect(422);
    });

    it('rejects mismatched or out-of-range parameters', async () => {
      const { variantId } = await stocked(`PR-VAL-${seq++}`);
      const base = { targetType: 'VARIANT', targetId: variantId };
      await createPromotion({ ...base, name: 'x', type: 'PERCENTAGE', percentageValue: 0 }).expect(422);
      await createPromotion({ ...base, name: 'x', type: 'PERCENTAGE', percentageValue: 101 }).expect(422);
      await createPromotion({ ...base, name: 'x', type: 'FIXED_AMOUNT', fixedAmount: 0 }).expect(422);
      await createPromotion({ ...base, name: 'x', type: 'BUY_X_GET_Y', buyQuantity: 0, getQuantity: 1 }).expect(422);
      await createPromotion({ ...base, name: 'x', type: 'BUY_X_GET_Y', buyQuantity: 1, getQuantity: 0 }).expect(422);
      await createPromotion({ ...base, name: '   ', type: 'PERCENTAGE', percentageValue: 10 }).expect(422);
      await createPromotion({ ...base, name: 'x', type: 'PERCENTAGE', percentageValue: 10, validFrom: '2026-05-10', validTo: '2026-05-01' }).expect(422);
    });

    it('cannot produce a hybrid rule: a stray parameter is ignored, and the database refuses one outright', async () => {
      const { variantId } = await stocked(`PR-HYBRID-${seq++}`);
      // No schema in this codebase uses `.strict()` - unknown keys are
      // stripped everywhere, so a stray `buyQuantity` on a PERCENTAGE is
      // ignored rather than rejected. What matters is that the stored row
      // can never be a hybrid, which is asserted directly.
      const created = await createPromotion({
        name: 'stray param',
        type: 'PERCENTAGE',
        percentageValue: 10,
        buyQuantity: 2,
        targetType: 'VARIANT',
        targetId: variantId,
      }).expect(201);
      const row = await admin.promotion.findUniqueOrThrow({ where: { id: created.body.data.id } });
      expect(row.percentageValue!.toString()).toBe('10');
      expect(row.buyQuantity).toBeNull();
      expect(row.getQuantity).toBeNull();
      expect(row.fixedAmount).toBeNull();

      // And the database itself refuses a hybrid, independently of the app.
      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO promotions (id, business_id, name, type, target_type, target_id, percentage_value, buy_quantity, get_quantity, valid_from, valid_to, updated_at)
           VALUES (gen_random_uuid(), '${biz.businessId}', 'hybrid', 'PERCENTAGE', 'VARIANT', '${variantId}', 10, 2, 1, now(), now() + interval '1 day', now())`,
        ),
      ).rejects.toThrow(/promotions_parameters_match_type/);
    });

    it('404s for a target that does not exist in this tenant', async () => {
      const foreign = await stocked(`PR-FOREIGN-${seq++}`, { token: other.accessToken, fixture: other });
      await createPromotion({ name: 'x', type: 'PERCENTAGE', percentageValue: 10, targetType: 'VARIANT', targetId: foreign.variantId }).expect(404);
      await createPromotion({ name: 'x', type: 'PERCENTAGE', percentageValue: 10, targetType: 'CATEGORY', targetId: '00000000-0000-4000-8000-000000000000' }).expect(404);
    });

    it('edits only name, window and active flag; deactivates rather than deletes', async () => {
      const { variantId } = await stocked(`PR-EDIT-${seq++}`);
      const created = await createPromotion({ name: 'Before', type: 'PERCENTAGE', percentageValue: 10, targetType: 'VARIANT', targetId: variantId }).expect(201);
      const id = created.body.data.id;

      const patched = await request(app.getHttpServer())
        .patch(`/api/v1/promotions/${id}`)
        .set('Authorization', auth())
        .send({ name: 'After' })
        .expect(200);
      expect(patched.body.data.name).toBe('After');
      // Type/target/parameters are not editable - a different rule is a
      // different promotion.
      expect(patched.body.data.type).toBe('PERCENTAGE');
      expect(patched.body.data.percentageValue).toBe('10');

      await request(app.getHttpServer()).delete(`/api/v1/promotions/${id}`).set('Authorization', auth()).expect(200);
      expect((await admin.promotion.findUniqueOrThrow({ where: { id } })).isActive).toBe(false);
      // Deactivating twice is a conflict, and the row still exists.
      await request(app.getHttpServer()).delete(`/api/v1/promotions/${id}`).set('Authorization', auth()).expect(409);
      expect(await admin.promotion.findUnique({ where: { id } })).not.toBeNull();
    });

    it('lists and filters promotions', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/promotions?type=PERCENTAGE&limit=5')
        .set('Authorization', auth())
        .expect(200);
      expect(res.body.data.every((p: { type: string }) => p.type === 'PERCENTAGE')).toBe(true);
      expect(res.body.pagination.limit).toBe(5);
      await request(app.getHttpServer()).get('/api/v1/promotions?limit=999').set('Authorization', auth()).expect(422);
    });
  });

  // ------------------------------------------------------------------
  describe('Calculation on real sales', () => {
    it('PERCENTAGE discounts the line gross and lands in SaleItem.discountAmount', async () => {
      const { variantId } = await stocked(`PR-PCT-${seq++}`);
      await createPromotion({ name: '20 off', type: 'PERCENTAGE', percentageValue: 20, targetType: 'VARIANT', targetId: variantId }).expect(201);

      const res = await sell({ items: [{ variantId, quantity: 2, unitPrice: 50 }], payments: [{ amount: 80 }] }).expect(201);
      const sale = await saleRow(res.body.data.id);
      expect(sale.subtotal.toString()).toBe('100');
      expect(sale.discountAmount.toString()).toBe('20');
      expect(sale.items[0].discountAmount.toString()).toBe('20');
      expect(sale.totalAmount.toString()).toBe('80');
    });

    it('FIXED_AMOUNT is PER UNIT and is capped at the line gross', async () => {
      const { variantId } = await stocked(`PR-FIX-${seq++}`);
      await createPromotion({ name: '5 per unit', type: 'FIXED_AMOUNT', fixedAmount: 5, targetType: 'VARIANT', targetId: variantId }).expect(201);
      const res = await sell({ items: [{ variantId, quantity: 4, unitPrice: 50 }], payments: [{ amount: 180 }] }).expect(201);
      // 5 x 4 = 20, not a flat 5.
      expect((await saleRow(res.body.data.id)).discountAmount.toString()).toBe('20');

      const { variantId: v2 } = await stocked(`PR-FIX2-${seq++}`);
      await createPromotion({ name: 'huge', type: 'FIXED_AMOUNT', fixedAmount: 500, targetType: 'VARIANT', targetId: v2 }).expect(201);
      const res2 = await sell({ items: [{ variantId: v2, quantity: 1, unitPrice: 100 }], payments: [] }).expect(201);
      const sale2 = await saleRow(res2.body.data.id);
      expect(sale2.discountAmount.toString()).toBe('100');
      expect(sale2.totalAmount.toString()).toBe('0');
    });

    it('BUY_X_GET_Y repeats for whole sets and gives nothing for a remainder', async () => {
      const { variantId } = await stocked(`PR-BXGY-${seq++}`);
      await createPromotion({ name: 'B2G1', type: 'BUY_X_GET_Y', buyQuantity: 2, getQuantity: 1, targetType: 'VARIANT', targetId: variantId }).expect(201);

      for (const [qty, expected] of [[3, '100'], [6, '200'], [5, '100'], [2, null]] as [number, string | null][]) {
        const due = qty * 100 - Number(expected ?? 0);
        const res = await sell({ items: [{ variantId, quantity: qty, unitPrice: 100 }], payments: [{ amount: due }] }).expect(201);
        const sale = await saleRow(res.body.data.id);
        expect(sale.discountAmount.toString()).toBe(expected ?? '0');
        expect((await applicationsFor(sale.id)).length).toBe(expected === null ? 0 : 1);
      }
    });
  });

  // ------------------------------------------------------------------
  describe('BD-10 - BXGY is PER LINE ONLY', () => {
    it('a category BXGY over two one-unit lines yields NO free unit', async () => {
      const categoryId = await createCategory(`Cat-BD10-${seq++}`);
      const a = await stocked(`PR-BD10-A-${seq++}`, { categoryId });
      const b = await stocked(`PR-BD10-B-${seq++}`, { categoryId });
      await createPromotion({ name: 'Cat B1G1', type: 'BUY_X_GET_Y', buyQuantity: 1, getQuantity: 1, targetType: 'CATEGORY', targetId: categoryId }).expect(201);

      const res = await sell({
        items: [
          { variantId: a.variantId, quantity: 1, unitPrice: 100 },
          { variantId: b.variantId, quantity: 1, unitPrice: 100 },
        ],
        payments: [{ amount: 200 }],
      }).expect(201);

      const sale = await saleRow(res.body.data.id);
      // Approved policy: quantities are NEVER aggregated across lines.
      expect(sale.discountAmount.toString()).toBe('0');
      expect(sale.items.every((i) => i.discountAmount.isZero())).toBe(true);
      expect(await applicationsFor(sale.id)).toEqual([]);
    });

    it('the same category BXGY DOES apply when one line completes a set on its own', async () => {
      const categoryId = await createCategory(`Cat-BD10B-${seq++}`);
      const a = await stocked(`PR-BD10C-${seq++}`, { categoryId });
      const b = await stocked(`PR-BD10D-${seq++}`, { categoryId });
      await createPromotion({ name: 'Cat B1G1', type: 'BUY_X_GET_Y', buyQuantity: 1, getQuantity: 1, targetType: 'CATEGORY', targetId: categoryId }).expect(201);

      const res = await sell({
        items: [
          { variantId: a.variantId, quantity: 2, unitPrice: 100 },
          { variantId: b.variantId, quantity: 1, unitPrice: 100 },
        ],
        payments: [{ amount: 200 }],
      }).expect(201);

      const sale = await saleRow(res.body.data.id);
      const lineA = sale.items.find((i) => i.variantId === a.variantId)!;
      const lineB = sale.items.find((i) => i.variantId === b.variantId)!;
      expect(lineA.discountAmount.toString()).toBe('100');
      expect(lineB.discountAmount.toString()).toBe('0');
      expect(sale.discountAmount.toString()).toBe('100');
    });
  });

  // ------------------------------------------------------------------
  describe('BD-11 - manual discount and promotion are additive, capped at line gross', () => {
    it('30 manual + 20 promotion on a 100 line = 50', async () => {
      const { variantId } = await stocked(`PR-BD11A-${seq++}`);
      await createPromotion({ name: '20%', type: 'PERCENTAGE', percentageValue: 20, targetType: 'VARIANT', targetId: variantId }).expect(201);

      const res = await sell({ items: [{ variantId, quantity: 1, unitPrice: 100, discountAmount: 30 }], payments: [{ amount: 50 }] }).expect(201);
      const sale = await saleRow(res.body.data.id);
      expect(sale.items[0].discountAmount.toString()).toBe('50');
      expect(sale.discountAmount.toString()).toBe('50');
      expect(sale.totalAmount.toString()).toBe('50');
      // The promotion is computed on the GROSS (100), not on the
      // post-manual price (70) - 20% of 70 would have been 14.
      const app = (await applicationsFor(sale.id))[0];
      expect(app.discountApplied.toString()).toBe('20');
    });

    it('90 manual + 30 promotion on a 100 line caps at 100, never rejected, never negative', async () => {
      const { variantId } = await stocked(`PR-BD11B-${seq++}`);
      await createPromotion({ name: '30%', type: 'PERCENTAGE', percentageValue: 30, targetType: 'VARIANT', targetId: variantId }).expect(201);

      const res = await sell({ items: [{ variantId, quantity: 1, unitPrice: 100, discountAmount: 90 }], payments: [] }).expect(201);
      const sale = await saleRow(res.body.data.id);
      expect(sale.items[0].discountAmount.toString()).toBe('100');
      expect(sale.discountAmount.toString()).toBe('100');
      expect(sale.totalAmount.toString()).toBe('0');
      expect(sale.subtotal.minus(sale.discountAmount).greaterThanOrEqualTo(0)).toBe(true);

      // Provenance records the EFFECTIVE contribution (10), and the
      // snapshot records what the rule COMPUTED (30) plus the cap flag.
      const app = (await applicationsFor(sale.id))[0];
      expect(app.discountApplied.toString()).toBe('10');
      const snap = app.ruleSnapshot as Record<string, unknown>;
      expect(snap.computedDiscount).toBe('30');
      expect(snap.cappedAtLineGross).toBe(true);
      expect(snap.manualDiscountAtSale).toBe('90');
    });

    it('a manual discount already covering the whole line records no application row', async () => {
      const { variantId } = await stocked(`PR-BD11C-${seq++}`);
      await createPromotion({ name: '30%', type: 'PERCENTAGE', percentageValue: 30, targetType: 'VARIANT', targetId: variantId }).expect(201);
      const res = await sell({ items: [{ variantId, quantity: 1, unitPrice: 100, discountAmount: 100 }], payments: [] }).expect(201);
      const sale = await saleRow(res.body.data.id);
      expect(sale.discountAmount.toString()).toBe('100');
      expect(await applicationsFor(sale.id)).toEqual([]);
    });

    it('a line with NO promotion is unaffected by the promotion path - a discount at the gross stands', async () => {
      const { variantId } = await stocked(`PR-BD11D-${seq++}`);
      // No promotion for this variant at all. A manual discount exactly
      // equal to the line gross is untouched (Phase 8E's BD-12 cap is the
      // identity here) and the customer still owes the tax.
      const res = await sell({ items: [{ variantId, quantity: 1, unitPrice: 100, discountAmount: 100, taxAmount: 20 }], payments: [{ amount: 20 }] }).expect(201);
      const sale = await saleRow(res.body.data.id);
      expect(sale.discountAmount.toString()).toBe('100');
      expect(sale.totalAmount.toString()).toBe('20');
    });
  });

  // ------------------------------------------------------------------
  describe('Best applicable only, and determinism', () => {
    it('picks the largest discount and records exactly one application per line', async () => {
      const { variantId, productId } = await stocked(`PR-BEST-${seq++}`);
      await createPromotion({ name: '10 pct', type: 'PERCENTAGE', percentageValue: 10, targetType: 'PRODUCT', targetId: productId }).expect(201);
      await createPromotion({ name: '15 per unit', type: 'FIXED_AMOUNT', fixedAmount: 15, targetType: 'VARIANT', targetId: variantId }).expect(201);

      // gross 1000: 10% = 100, 15/unit x 10 = 150 -> fixed wins.
      const res = await sell({ items: [{ variantId, quantity: 10, unitPrice: 100 }], payments: [{ amount: 850 }] }).expect(201);
      const sale = await saleRow(res.body.data.id);
      expect(sale.discountAmount.toString()).toBe('150');
      const apps = await applicationsFor(sale.id);
      expect(apps.length).toBe(1);
      expect(apps[0].promotionName).toBe('15 per unit');
      expect(apps[0].promotionType).toBe('FIXED_AMOUNT');
    });

    it('breaks an exact tie by target specificity - VARIANT beats CATEGORY', async () => {
      const categoryId = await createCategory(`Cat-Tie-${seq++}`);
      const { variantId } = await stocked(`PR-TIE-${seq++}`, { categoryId });
      await createPromotion({ name: 'category 10', type: 'PERCENTAGE', percentageValue: 10, targetType: 'CATEGORY', targetId: categoryId }).expect(201);
      await createPromotion({ name: 'variant 10', type: 'PERCENTAGE', percentageValue: 10, targetType: 'VARIANT', targetId: variantId }).expect(201);

      const res = await sell({ items: [{ variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 90 }] }).expect(201);
      const apps = await applicationsFor(res.body.data.id);
      expect(apps.length).toBe(1);
      expect(apps[0].promotionName).toBe('variant 10');
    });

    it('different lines of one sale may carry different promotions', async () => {
      const a = await stocked(`PR-MIX-A-${seq++}`);
      const b = await stocked(`PR-MIX-B-${seq++}`);
      await createPromotion({ name: 'A 10pct', type: 'PERCENTAGE', percentageValue: 10, targetType: 'VARIANT', targetId: a.variantId }).expect(201);
      await createPromotion({ name: 'B fixed 25', type: 'FIXED_AMOUNT', fixedAmount: 25, targetType: 'VARIANT', targetId: b.variantId }).expect(201);

      const res = await sell({
        items: [
          { variantId: a.variantId, quantity: 1, unitPrice: 100 },
          { variantId: b.variantId, quantity: 1, unitPrice: 100 },
        ],
        payments: [{ amount: 165 }],
      }).expect(201);
      const sale = await saleRow(res.body.data.id);
      expect(sale.discountAmount.toString()).toBe('35');
      const apps = await applicationsFor(sale.id);
      expect(apps.map((x) => x.promotionName).sort()).toEqual(['A 10pct', 'B fixed 25']);
      const lineSum = sale.items.reduce((s, i) => s.plus(i.discountAmount), D(0));
      expect(lineSum.toString()).toBe(sale.discountAmount.toString());
    });

    it('the same promotion cannot be applied twice to one line', async () => {
      const sale = await admin.salePromotionApplication.findFirstOrThrow({});
      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO sale_promotion_applications (id, business_id, sale_id, sale_item_id, promotion_id, promotion_type, promotion_name, rule_snapshot, discount_applied)
           VALUES (gen_random_uuid(), '${sale.businessId}', '${sale.saleId}', '${sale.saleItemId}', '${sale.promotionId}', 'PERCENTAGE', 'dup', '{}', 1)`,
        ),
      ).rejects.toThrow(/business_id, sale_item_id, promotion_id/);
    });
  });

  // ------------------------------------------------------------------
  describe('Validity windows in the business timezone', () => {
    it('an expired or not-yet-started promotion does not apply', async () => {
      const { variantId } = await stocked(`PR-WINDOW-${seq++}`);
      await createPromotion({ name: 'expired', type: 'PERCENTAGE', percentageValue: 50, targetType: 'VARIANT', targetId: variantId, validFrom: '2020-01-01', validTo: '2020-01-31' }).expect(201);
      await createPromotion({ name: 'future', type: 'PERCENTAGE', percentageValue: 50, targetType: 'VARIANT', targetId: variantId, validFrom: '2090-01-01', validTo: '2090-12-31' }).expect(201);

      const res = await sell({ items: [{ variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 100 }] }).expect(201);
      expect((await saleRow(res.body.data.id)).discountAmount.toString()).toBe('0');
    });

    it('an inactive promotion does not apply', async () => {
      const { variantId } = await stocked(`PR-INACTIVE-${seq++}`);
      const p = await createPromotion({ name: 'off', type: 'PERCENTAGE', percentageValue: 50, targetType: 'VARIANT', targetId: variantId }).expect(201);
      await request(app.getHttpServer()).delete(`/api/v1/promotions/${p.body.data.id}`).set('Authorization', auth()).expect(200);

      const res = await sell({ items: [{ variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 100 }] }).expect(201);
      expect((await saleRow(res.body.data.id)).discountAmount.toString()).toBe('0');
    });

    it('the stored window is half-open and resolved in the business timezone', async () => {
      const { variantId } = await stocked(`PR-TZ-${seq++}`);
      const p = await createPromotion({ name: 'tz', type: 'PERCENTAGE', percentageValue: 10, targetType: 'VARIANT', targetId: variantId, validFrom: '2026-03-01', validTo: '2026-03-31' }).expect(201);
      const row = await admin.promotion.findUniqueOrThrow({ where: { id: p.body.data.id } });

      const business = await admin.business.findUniqueOrThrow({ where: { id: biz.businessId } });
      const localFrom = new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(row.validFrom);
      const localTo = new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(row.validTo);
      expect(localFrom).toBe('2026-03-01');
      // Inclusive 31 March as written becomes the EXCLUSIVE instant at the
      // start of 1 April local time, so the whole final day is covered once.
      expect(localTo).toBe('2026-04-01');
    });
  });

  // ------------------------------------------------------------------
  describe('Historical integrity', () => {
    it('editing and deactivating a promotion never changes a completed sale', async () => {
      const { variantId } = await stocked(`PR-HIST-${seq++}`);
      const p = await createPromotion({ name: 'Original name', type: 'PERCENTAGE', percentageValue: 25, targetType: 'VARIANT', targetId: variantId }).expect(201);
      const res = await sell({ items: [{ variantId, quantity: 2, unitPrice: 100 }], payments: [{ amount: 150 }] }).expect(201);

      const before = await saleRow(res.body.data.id);
      const appBefore = (await applicationsFor(before.id))[0];
      expect(before.discountAmount.toString()).toBe('50');

      await request(app.getHttpServer())
        .patch(`/api/v1/promotions/${p.body.data.id}`)
        .set('Authorization', auth())
        .send({ name: 'Renamed', validFrom: '2091-01-01', validTo: '2091-12-31' })
        .expect(200);
      await request(app.getHttpServer()).delete(`/api/v1/promotions/${p.body.data.id}`).set('Authorization', auth()).expect(200);

      const after = await saleRow(before.id);
      expect(after.discountAmount.toString()).toBe(before.discountAmount.toString());
      expect(after.items[0].discountAmount.toString()).toBe(before.items[0].discountAmount.toString());

      const appAfter = (await applicationsFor(before.id))[0];
      expect(appAfter.promotionName).toBe('Original name');
      expect(appAfter.discountApplied.toString()).toBe(appBefore.discountApplied.toString());
      expect((appAfter.ruleSnapshot as Record<string, unknown>).percentageValue).toBe('25');
    });

    it('provenance is append-only: the runtime role cannot UPDATE or DELETE it', async () => {
      const grants: Array<{ privilege_type: string }> = await admin.$queryRawUnsafe(`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'erp_app' AND table_name = 'sale_promotion_applications' ORDER BY privilege_type
      `);
      expect(grants.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);

      const row = await admin.salePromotionApplication.findFirstOrThrow({ where: { businessId: biz.businessId } });
      const runtime = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
      try {
        await expect(
          runtime.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
            return tx.$executeRawUnsafe(`UPDATE sale_promotion_applications SET discount_applied = 1 WHERE id = '${row.id}'`);
          }),
        ).rejects.toThrow(/permission denied/i);
        await expect(
          runtime.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
            return tx.$executeRawUnsafe(`DELETE FROM sale_promotion_applications WHERE id = '${row.id}'`);
          }),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await runtime.$disconnect();
      }
      const after = await admin.salePromotionApplication.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.discountApplied.toString()).toBe(row.discountApplied.toString());
    });

    it('a promotion referenced by a sale cannot be deleted', async () => {
      const row = await admin.salePromotionApplication.findFirstOrThrow({ where: { businessId: biz.businessId } });
      await expect(admin.promotion.delete({ where: { id: row.promotionId } })).rejects.toThrow();
    });
  });

  // ------------------------------------------------------------------
  describe('Loyalty interaction', () => {
    beforeAll(async () => {
      await request(app.getHttpServer()).put('/api/v1/settings').set('Authorization', auth()).send({ key: 'loyalty.currency_per_point', value: 0.01 }).expect(200);
      await request(app.getHttpServer()).put('/api/v1/settings').set('Authorization', auth()).send({ key: 'loyalty.points_per_currency_unit', value: 2 }).expect(200);
    });

    it('redemption eligibility excludes the promoted amount, and earning is net of both', async () => {
      const { variantId } = await stocked(`PR-LOY-${seq++}`);
      await createPromotion({ name: '20%', type: 'PERCENTAGE', percentageValue: 20, targetType: 'VARIANT', targetId: variantId }).expect(201);
      const cust = await createCustomer(`Loyal ${seq++}`);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${cust}/points/adjust`)
        .set('Authorization', auth())
        .send({ points: 5000, reason: 'seed', idempotencyKey: `pl-${Date.now()}-${seq++}` })
        .expect(201);

      // gross 300, promotion 60, redemption 50 -> net 190, earns floor(190x2)=380
      const res = await sell({
        customerId: cust,
        items: [{ variantId, quantity: 3, unitPrice: 100 }],
        redeemPoints: 5000,
        payments: [{ amount: 190 }],
      }).expect(201);

      const sale = await saleRow(res.body.data.id);
      expect(sale.discountAmount.toString()).toBe('110');
      expect(sale.totalAmount.toString()).toBe('190');
      const lineSum = sale.items.reduce((s, i) => s.plus(i.discountAmount), D(0));
      expect(lineSum.toString()).toBe('110');

      const earn = await admin.customerPoints.findFirstOrThrow({ where: { referenceId: sale.id, type: 'EARN' } });
      expect(earn.basisAmount!.toString()).toBe('190');
      expect(earn.points.toString()).toBe('380');
    });

    it('redemption cannot exceed the merchandise value left after the promotion', async () => {
      const { variantId } = await stocked(`PR-LOY2-${seq++}`);
      await createPromotion({ name: '50%', type: 'PERCENTAGE', percentageValue: 50, targetType: 'VARIANT', targetId: variantId }).expect(201);
      const cust = await createCustomer(`Loyal2 ${seq++}`);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${cust}/points/adjust`)
        .set('Authorization', auth())
        .send({ points: 20000, reason: 'seed', idempotencyKey: `pl2-${Date.now()}-${seq++}` })
        .expect(201);

      // gross 100, promotion 50 -> only 50 left; 10000 pts = 100.00 > 50.
      const salesBefore = await admin.sale.count({ where: { businessId: biz.businessId } });
      await sell({ customerId: cust, items: [{ variantId, quantity: 1, unitPrice: 100 }], redeemPoints: 10000, payments: [] }).expect(422);
      expect(await admin.sale.count({ where: { businessId: biz.businessId } })).toBe(salesBefore);
    });

    it('an idempotent replay of a PROMOTED sale is not misread as a payload mismatch', async () => {
      const { variantId } = await stocked(`PR-IDEM-${seq++}`);
      await createPromotion({ name: '10%', type: 'PERCENTAGE', percentageValue: 10, targetType: 'VARIANT', targetId: variantId }).expect(201);
      const key = `promo-idem-${Date.now()}-${seq++}`;
      const body = { items: [{ variantId, quantity: 1, unitPrice: 100, discountAmount: 5 }], payments: [{ amount: 85 }], idempotencyKey: key };

      const first = await sell(body).expect(201);
      const replay = await sell(body).expect(201);
      expect(replay.body.data.id).toBe(first.body.data.id);
      expect((await applicationsFor(first.body.data.id)).length).toBe(1);

      // A genuinely different manual discount is still rejected.
      await sell({ ...body, items: [{ variantId, quantity: 1, unitPrice: 100, discountAmount: 7 }] }).expect(409);
    });
  });

  // ------------------------------------------------------------------
  describe('Returns, accounting and inventory', () => {
    it('a promoted line returns at its historical proportional value', async () => {
      const { variantId } = await stocked(`PR-RET-${seq++}`);
      await createPromotion({ name: 'B2G1', type: 'BUY_X_GET_Y', buyQuantity: 2, getQuantity: 1, targetType: 'VARIANT', targetId: variantId }).expect(201);
      const cust = await createCustomer(`Ret ${seq++}`);

      // 3 units at 100, one free -> merchandise 200.
      const res = await sell({ customerId: cust, items: [{ variantId, quantity: 3, unitPrice: 100 }], payments: [{ amount: 200 }] }).expect(201);
      const saleItemId = res.body.data.items[0].id;

      const credits: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await request(app.getHttpServer())
          .post(`/api/v1/sales/${res.body.data.id}/returns`)
          .set('Authorization', auth())
          .send({ items: [{ saleItemId, quantity: 1, condition: 'SELLABLE' }] })
          .expect(201);
        const txn = await admin.customerTransaction.findFirstOrThrow({ where: { referenceType: 'SaleReturn', referenceId: r.body.data.id, type: 'SALE_RETURN' } });
        credits.push(txn.amount.negated().toString());
      }
      // Exactly the BD-1 cumulative sequence - never 300.
      expect(credits).toEqual(['66.6667', '66.6666', '66.6667']);
      const total = credits.reduce((s, c) => s.plus(c), D(0));
      expect(total.toString()).toBe('200');
    });

    it('the GL posts revenue NET of the promotion and balances', async () => {
      const { variantId } = await stocked(`PR-GL-${seq++}`);
      await createPromotion({ name: '25%', type: 'PERCENTAGE', percentageValue: 25, targetType: 'VARIANT', targetId: variantId }).expect(201);
      const res = await sell({ items: [{ variantId, quantity: 4, unitPrice: 100 }], payments: [{ amount: 300 }] }).expect(201);

      const entry = await admin.journalEntry.findFirstOrThrow({
        where: { sourceType: 'Sale', sourceId: res.body.data.id },
        include: { lines: { include: { account: true } } },
      });
      const revenue = entry.lines.find((l) => l.account.name.toLowerCase().includes('revenue'))!;
      expect(revenue.credit.toString()).toBe('300');
      const debit = entry.lines.reduce((s, l) => s.plus(l.debit), D(0));
      const credit = entry.lines.reduce((s, l) => s.plus(l.credit), D(0));
      expect(debit.toString()).toBe(credit.toString());

      // No promotion account or promotion-described journal line exists.
      expect(await admin.account.findMany({ where: { businessId: biz.businessId, name: { contains: 'romotion' } } })).toEqual([]);
    });

    it('a promotion moves no stock - free units are still consumed', async () => {
      const { variantId } = await stocked(`PR-INV-${seq++}`, { qty: 100 });
      await createPromotion({ name: 'B2G1', type: 'BUY_X_GET_Y', buyQuantity: 2, getQuantity: 1, targetType: 'VARIANT', targetId: variantId }).expect(201);

      const before = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
      await sell({ items: [{ variantId, quantity: 3, unitPrice: 100 }], payments: [{ amount: 200 }] }).expect(201);
      const after = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });

      // All three units left the shelf, including the free one.
      expect(before.quantityOnHand.minus(after.quantityOnHand).toString()).toBe('3');
    });
  });

  // ------------------------------------------------------------------
  describe('Tenant isolation and permissions', () => {
    it("business B never sees or reaches business A's promotions", async () => {
      const otherAuth = `Bearer ${other.accessToken}`;
      const mine = await admin.promotion.findFirstOrThrow({ where: { businessId: biz.businessId } });

      await request(app.getHttpServer()).get(`/api/v1/promotions/${mine.id}`).set('Authorization', otherAuth).expect(404);
      await request(app.getHttpServer()).patch(`/api/v1/promotions/${mine.id}`).set('Authorization', otherAuth).send({ name: 'hijack' }).expect(404);
      await request(app.getHttpServer()).delete(`/api/v1/promotions/${mine.id}`).set('Authorization', otherAuth).expect(404);

      const list = await request(app.getHttpServer()).get('/api/v1/promotions').set('Authorization', otherAuth).expect(200);
      expect(list.body.data.some((p: { id: string }) => p.id === mine.id)).toBe(false);
    });

    it("business A's promotion never discounts business B's sale", async () => {
      const foreign = await stocked(`PR-TENANT-${seq++}`, { token: other.accessToken, fixture: other });
      const res = await sell(
        { items: [{ variantId: foreign.variantId, quantity: 5, unitPrice: 100 }], payments: [{ amount: 500 }] },
        `Bearer ${other.accessToken}`,
        other,
      ).expect(201);
      expect((await saleRow(res.body.data.id)).discountAmount.toString()).toBe('0');
    });

    it('RLS blocks a cross-tenant read at the database layer', async () => {
      const mine = await admin.promotion.findFirstOrThrow({ where: { businessId: biz.businessId } });
      const runtime = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
      try {
        const rows = await runtime.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${other.businessId}'`);
          return tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM promotions WHERE id = '${mine.id}'`);
        });
        expect(rows).toHaveLength(0);
        const unfiltered = await runtime.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM promotions`);
        expect(unfiltered).toHaveLength(0);
      } finally {
        await runtime.$disconnect();
      }
    });

    it('enforces the full permission matrix', async () => {
      await request(app.getHttpServer()).get('/api/v1/promotions').expect(401);

      const mine = await admin.promotion.findFirstOrThrow({ where: { businessId: biz.businessId } });
      async function loginAs(roleName: string, prefix: string) {
        const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: roleName } });
        const email = `${prefix}@${biz.slug}.test`;
        await request(app.getHttpServer())
          .post('/api/v1/users')
          .set('Authorization', auth())
          .send({ name: prefix, email, password: 'RoleUserPass1!', roleIds: [role.id], branchIds: [] })
          .expect(201);
        const login = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email, password: 'RoleUserPass1!', businessSlug: biz.slug })
          .expect(200);
        return `Bearer ${login.body.data.accessToken}`;
      }

      for (const role of ['CASHIER', 'SALES_EMPLOYEE', 'BRANCH_MANAGER', 'ACCOUNTANT']) {
        const token = await loginAs(role, `promo${role.toLowerCase()}`);
        await request(app.getHttpServer()).get('/api/v1/promotions').set('Authorization', token).expect(200);
        await request(app.getHttpServer())
          .post('/api/v1/promotions')
          .set('Authorization', token)
          .send({ name: 'x', type: 'PERCENTAGE', percentageValue: 10, targetType: 'VARIANT', targetId: mine.targetId, validFrom: YESTERDAY, validTo: FAR_FUTURE })
          .expect(403);
        await request(app.getHttpServer()).patch(`/api/v1/promotions/${mine.id}`).set('Authorization', token).send({ name: 'x' }).expect(403);
        await request(app.getHttpServer()).delete(`/api/v1/promotions/${mine.id}`).set('Authorization', token).expect(403);
      }

      const invMgr = await loginAs('INVENTORY_MANAGER', 'promoinvmgr');
      await request(app.getHttpServer()).get('/api/v1/promotions').set('Authorization', invMgr).expect(403);
    });
  });
});
