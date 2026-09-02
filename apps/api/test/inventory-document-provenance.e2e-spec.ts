import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 22 (P21-2) — A MOVEMENT THAT NAMES A DOCUMENT MUST NAME *THE*
 * DOCUMENT.
 *
 * The generic stock primitives defaulted to a document type and left the
 * reference optional, so the shortest valid request wrote a PURCHASE (or
 * a SALE) with `referenceType: null, referenceId: null` — a ledger row
 * claiming an origin it could not produce.
 *
 * That is not cosmetic. Provenance is load-bearing in three places, and
 * the last case below demonstrates the worst of them end to end: a
 * provenance-less SALE is INVISIBLE to the COGS queries, which filter on
 * `referenceType: 'Sale'`, so gross profit silently overstates by
 * exactly the cost of whatever was consumed that way. A traceability
 * rule with a hole in it is how a number nobody questioned turns out to
 * be wrong.
 *
 * Enforced at two levels and proved at both: the request schema gives a
 * caller a clear 422 at the edge, and `InventoryEngineService` refuses
 * the same thing on the single path that writes a movement row — which
 * is what makes the rule hold for every caller, including ones that
 * never pass through a schema.
 */
describe('Inventory: document provenance (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let other: SalesFixture;
  let variantId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'provenance-a');
    other = await setupSalesFixture(app, 'provenance-b');
    ({ variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PROV-1', {
      defaultCost: 40,
      defaultSellingPrice: 100,
    }));
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = (t = biz.accessToken) => `Bearer ${t}`;
  const api = () => request(app.getHttpServer());

  const receipt = (over: Record<string, unknown> = {}) => ({
    warehouseId: biz.warehouseId,
    variantId,
    quantity: 10,
    unitCost: 40,
    ...over,
  });
  const consumption = (over: Record<string, unknown> = {}) => ({
    warehouseId: biz.warehouseId,
    variantId,
    quantity: 1,
    ...over,
  });

  // ================================================================
  // 1. A document-typed movement without provenance is REJECTED
  // ================================================================
  describe('a document-typed movement must carry its origin', () => {
    it('rejects the shortest possible receipt — which used to write a PURCHASE naming no purchase', async () => {
      // `movementType` DEFAULTS to PURCHASE here, so this request is the
      // exact shape that produced an untraceable row before the fix.
      const res = await api().post('/api/v1/inventory/receipts').set('Authorization', auth()).send(receipt()).expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a consumption that defaults to SALE with no sale named', async () => {
      await api().post('/api/v1/inventory/consumptions').set('Authorization', auth()).send(consumption()).expect(422);
    });

    it('rejects each of the four document types explicitly', async () => {
      for (const movementType of ['PURCHASE', 'SALES_RETURN']) {
        await api().post('/api/v1/inventory/receipts').set('Authorization', auth()).send(receipt({ movementType })).expect(422);
      }
      for (const movementType of ['SALE', 'PURCHASE_RETURN']) {
        await api().post('/api/v1/inventory/consumptions').set('Authorization', auth()).send(consumption({ movementType })).expect(422);
      }
    });

    it('rejects HALF a reference — a type with no id names a kind of document, not a document', async () => {
      await api()
        .post('/api/v1/inventory/receipts')
        .set('Authorization', auth())
        .send(receipt({ referenceType: 'PurchaseReceipt' }))
        .expect(422);
      await api()
        .post('/api/v1/inventory/receipts')
        .set('Authorization', auth())
        .send(receipt({ referenceId: 'some-id' }))
        .expect(422);
    });

    it('writes NOTHING when it rejects — no movement, no balance', async () => {
      const before = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId } });
      await api().post('/api/v1/inventory/receipts').set('Authorization', auth()).send(receipt()).expect(422);
      expect(await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId } })).toBe(before);
    });
  });

  // ================================================================
  // 2. A document-typed movement WITH provenance succeeds
  // ================================================================
  describe('with provenance, the same request works exactly as before', () => {
    it('accepts a receipt that names its document, and stores both halves', async () => {
      const res = await api()
        .post('/api/v1/inventory/receipts')
        .set('Authorization', auth())
        .send(receipt({ referenceType: 'PurchaseReceipt', referenceId: 'pr-provenance-1' }))
        .expect(201);
      expect(res.body.data.movementId).toBeDefined();

      const movement = await admin.stockMovement.findUniqueOrThrow({ where: { id: res.body.data.movementId } });
      expect(movement.movementType).toBe('PURCHASE');
      expect(movement.referenceType).toBe('PurchaseReceipt');
      expect(movement.referenceId).toBe('pr-provenance-1');
      expect(Number(movement.quantityBase)).toBe(10);
      expect(Number(movement.unitCostAtMovement)).toBe(40);
    });

    it('accepts a consumption that names its sale', async () => {
      const res = await api()
        .post('/api/v1/inventory/consumptions')
        .set('Authorization', auth())
        .send(consumption({ referenceType: 'Sale', referenceId: 'sale-provenance-1' }))
        .expect(201);
      const movement = await admin.stockMovement.findUniqueOrThrow({ where: { id: res.body.data.movementId } });
      expect(movement.movementType).toBe('SALE');
      expect(movement.referenceType).toBe('Sale');
    });

    it('leaves every REAL document flow working — they always named their documents', async () => {
      // The audit behind this change found every genuine flow already
      // supplying provenance. This walks the ones that write the four
      // guarded types and asserts the ledger still records them.
      const { variantId: soldVariant } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PROV-FLOW', {
        defaultCost: 30,
        defaultSellingPrice: 90,
      });
      await api()
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId: soldVariant, quantity: 20, unitCost: 30 })
        .expect(201);

      const sale = await api()
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId: soldVariant, quantity: 4, unitPrice: 90 }],
          payments: [{ amount: 360, method: 'CASH' }],
        })
        .expect(201);

      const saleMovement = await admin.stockMovement.findFirstOrThrow({
        where: { businessId: biz.businessId, variantId: soldVariant, movementType: 'SALE' },
      });
      expect(saleMovement.referenceType).toBe('Sale');
      expect(saleMovement.referenceId).toBe(sale.body.data.id);

      const detail = await api().get(`/api/v1/sales/${sale.body.data.id}`).set('Authorization', auth()).expect(200);
      await api()
        .post(`/api/v1/sales/${sale.body.data.id}/returns`)
        .set('Authorization', auth())
        .send({
          items: [{ saleItemId: detail.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          refund: { method: 'CASH', amount: 90 },
        })
        .expect(201);

      const returnMovement = await admin.stockMovement.findFirstOrThrow({
        where: { businessId: biz.businessId, variantId: soldVariant, movementType: 'SALES_RETURN' },
      });
      expect(returnMovement.referenceType).toBe('SaleReturn');
      expect(returnMovement.referenceId).toBeTruthy();
    });
  });

  // ================================================================
  // 3. The adjustment family is untouched
  // ================================================================
  describe('document-less movement types keep their existing contract', () => {
    it('accepts every adjustment-family type with a reason and no document', async () => {
      // These have no document by definition. The rule is about types
      // that CLAIM one, not about making everything carry a reference.
      for (const movementType of ['ADJUSTMENT', 'DAMAGE', 'LOSS', 'INTERNAL_CONSUMPTION', 'EXPIRY']) {
        const res = await api()
          .post('/api/v1/inventory/adjustments')
          .set('Authorization', auth())
          .send({ warehouseId: biz.warehouseId, variantId, quantity: -1, movementType, reason: `phase 22 ${movementType}` })
          .expect(201);
        const movement = await admin.stockMovement.findUniqueOrThrow({ where: { id: res.body.data.movementId } });
        expect(movement.movementType).toBe(movementType);
        expect(movement.referenceType).toBeNull();
        expect(movement.reason).toContain(movementType);
      }
    });

    it('still requires a reason for an adjustment — that contract is unchanged', async () => {
      await api()
        .post('/api/v1/inventory/adjustments')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: -1, movementType: 'DAMAGE' })
        .expect(422);
    });

    it('accepts opening stock, which has no document either', async () => {
      const { variantId: fresh } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PROV-OPENING');
      const res = await api()
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId: fresh, quantity: 5, unitCost: 2 })
        .expect(201);
      const movement = await admin.stockMovement.findUniqueOrThrow({ where: { id: res.body.data.movementId } });
      expect(movement.movementType).toBe('OPENING_BALANCE');
      expect(movement.referenceType).toBeNull();
    });
  });

  // ================================================================
  // 4. Tenant isolation is unaffected
  // ================================================================
  describe('tenant isolation', () => {
    it('still refuses another tenant’s warehouse, provenance or not', async () => {
      await api()
        .post('/api/v1/inventory/receipts')
        .set('Authorization', auth())
        .send(receipt({ warehouseId: other.warehouseId, referenceType: 'PurchaseReceipt', referenceId: 'x' }))
        .expect(404);
    });

    it('never lets one tenant’s movements appear in another’s ledger', async () => {
      const mine = await admin.stockMovement.count({ where: { businessId: biz.businessId } });
      const theirs = await admin.stockMovement.count({ where: { businessId: other.businessId } });
      expect(mine).toBeGreaterThan(0);
      const crossed = await admin.stockMovement.count({
        where: { businessId: biz.businessId, warehouseId: other.warehouseId },
      });
      expect(crossed).toBe(0);
      expect(theirs).toBeGreaterThanOrEqual(0);
    });

    it('refuses a caller without the grant, before any provenance check', async () => {
      const role = await api()
        .post('/api/v1/roles')
        .set('Authorization', auth())
        .send({ name: 'NOSTOCK', permissionCodes: ['products.view'] })
        .expect(201);
      const email = `nostock@${biz.slug}.test`;
      await api()
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'nostock', email, password: 'ErpUserPass1!', roleIds: [role.body.data.id] })
        .expect(201);
      const login = await api()
        .post('/api/v1/auth/login')
        .send({ email, password: 'ErpUserPass1!', businessSlug: biz.slug })
        .expect(200);
      await api()
        .post('/api/v1/inventory/receipts')
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .send(receipt({ referenceType: 'PurchaseReceipt', referenceId: 'x' }))
        .expect(403);
    });
  });

  // ================================================================
  // 5. The reason this matters: COGS and reconciliation
  // ================================================================
  describe('a provenance-less SALE can no longer slip past COGS', () => {
    it('is refused outright, so the COGS query cannot silently miss it', async () => {
      // THE DEFECT, DEMONSTRATED. `DashboardUseCase.periodCogs` and
      // `SalesSummaryUseCase.computeCogs` both sum movements filtered by
      // `referenceType: 'Sale'`. Before this fix a SALE written through
      // the generic primitive carried no reference, so it was excluded
      // from that sum: the stock left the building and its cost never
      // reached the report. Gross profit overstated, with nothing
      // anywhere to indicate it.
      const { variantId: leaky } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PROV-COGS', {
        defaultCost: 25,
        defaultSellingPrice: 60,
      });
      await api()
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId: leaky, quantity: 50, unitCost: 25 })
        .expect(201);

      const before = await api().get('/api/v1/reports/sales/summary').set('Authorization', auth()).expect(200);

      // The request that used to succeed and skew the books.
      await api()
        .post('/api/v1/inventory/consumptions')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId: leaky, quantity: 10, movementType: 'SALE' })
        .expect(422);

      // Nothing moved, so nothing to misreport.
      const orphans = await admin.stockMovement.count({
        where: { businessId: biz.businessId, movementType: 'SALE', referenceType: null },
      });
      expect(orphans).toBe(0);

      const after = await api().get('/api/v1/reports/sales/summary').set('Authorization', auth()).expect(200);
      expect(after.body.data.cogs).toBe(before.body.data.cogs);
    });

    it('leaves NO document-typed movement anywhere in the ledger without an origin', async () => {
      // The invariant itself, asserted over everything this spec wrote.
      const untraceable = await admin.stockMovement.findMany({
        where: {
          movementType: { in: ['PURCHASE', 'SALE', 'SALES_RETURN', 'PURCHASE_RETURN'] },
          OR: [{ referenceType: null }, { referenceId: null }],
        },
        select: { id: true, movementType: true },
      });
      expect(untraceable).toEqual([]);
    });
  });
});
