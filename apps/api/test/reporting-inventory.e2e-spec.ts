import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

describe('Reporting: inventory reports (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let soldVariant: string;
  let staleVariant: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'rpt-inventory');

    ({ variantId: soldVariant } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RPT-INV-SOLD'));
    ({ variantId: staleVariant } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RPT-INV-STALE'));
    await stockUp(soldVariant, 40, 5);
    await stockUp(staleVariant, 10, 3);

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId: soldVariant, quantity: 4, unitPrice: 20 }], payments: [{ amount: 80 }] })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId: soldVariant, quantity: -3, movementType: 'DAMAGE', reason: 'reporting damage test' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId: staleVariant, quantity: -2, movementType: 'LOSS', reason: 'reporting loss test' })
      .expect(201);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function stockUp(variantId: string, quantity: number, unitCost: number) {
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity, unitCost })
      .expect(201);
  }

  it('VALUATION: value per variant equals quantityOnHand x averageCost from the balance cache, and the total covers the whole filtered set', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/reports/inventory/valuation').set('Authorization', auth()).expect(200);

    const sold = res.body.data.find((r: { variantId: string }) => r.variantId === soldVariant);
    // 40 opening - 4 sold - 3 damaged = 33 @ cost 5
    expect(Number(sold.quantityOnHand)).toBe(33);
    expect(Number(sold.inventoryValue)).toBeCloseTo(33 * 5, 4);

    // Cross-check the grand total independently against the balance table.
    const balances = await admin.stockBalance.findMany({ where: { businessId: biz.businessId } });
    const expected = balances.reduce((s, b) => s + Number(b.quantityOnHand) * Number(b.averageCost), 0);
    expect(Number(res.body.summary.inventoryValue)).toBeCloseTo(expected, 4);
  });

  it('VALUATION: uses the Stock Ledger balance, never Product.defaultCost', async () => {
    // Both test products were created with defaultCost 0; if the report
    // were sourcing cost from the product record the value would be 0.
    const product = await admin.productVariant.findFirstOrThrow({ where: { id: soldVariant }, include: { product: true } });
    expect(Number(product.product.defaultCost)).toBe(0);

    const res = await request(app.getHttpServer()).get('/api/v1/reports/inventory/valuation').set('Authorization', auth()).expect(200);
    const sold = res.body.data.find((r: { variantId: string }) => r.variantId === soldVariant);
    expect(Number(sold.averageCost)).toBe(5);
    expect(Number(sold.inventoryValue)).toBeGreaterThan(0);
  });

  it('MOVEMENTS: returns the raw ledger with historical unitCostAtMovement, filterable by type', async () => {
    const all = await request(app.getHttpServer()).get('/api/v1/reports/inventory/movements').set('Authorization', auth()).expect(200);
    expect(all.body.pagination.total).toBeGreaterThan(0);

    const damageOnly = await request(app.getHttpServer())
      .get('/api/v1/reports/inventory/movements')
      .query({ movementType: 'DAMAGE' })
      .set('Authorization', auth())
      .expect(200);
    expect(damageOnly.body.data.length).toBe(1);
    expect(damageOnly.body.data[0].movementType).toBe('DAMAGE');
    expect(Number(damageOnly.body.data[0].unitCostAtMovement)).toBe(5);
    expect(Number(damageOnly.body.data[0].movementValue)).toBe(15);
  });

  it('DAMAGE/LOSS: summarises write-offs by type with values from each movement own cost', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/reports/inventory/damage-loss').set('Authorization', auth()).expect(200);
    const damage = res.body.summary.find((s: { movementType: string }) => s.movementType === 'DAMAGE');
    const loss = res.body.summary.find((s: { movementType: string }) => s.movementType === 'LOSS');
    expect(Number(damage.quantity)).toBe(3);
    expect(Number(damage.movementValue)).toBe(15); // 3 x 5
    expect(Number(loss.quantity)).toBe(2);
    expect(Number(loss.movementValue)).toBe(6); // 2 x 3
  });

  it('SLOW MOVING: lists stocked variants with no recent SALE, and excludes ones that did sell', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/reports/inventory/slow-moving')
      .query({ days: 30 })
      .set('Authorization', auth())
      .expect(200);

    const keys = res.body.data.map((r: { variantId: string }) => r.variantId);
    expect(keys).toContain(staleVariant); // never sold
    expect(keys).not.toContain(soldVariant); // sold just now
    expect(res.body.criteria.days).toBe(30);
    expect(res.body.criteria.definition).toMatch(/no SALE/i);
  });

  it('COST GATING: a caller without products.view_cost gets no cost/value fields on any inventory report', async () => {
    const bmRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'BRANCH_MANAGER' } });
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: 'Inv BM', email: `invbm@${biz.slug}.test`, password: 'BranchMgr1!', roleIds: [bmRole.id], branchIds: [biz.branchId] })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `invbm@${biz.slug}.test`, password: 'BranchMgr1!', businessSlug: biz.slug })
      .expect(200);
    const bmAuth = `Bearer ${login.body.data.accessToken}`;

    const valuation = await request(app.getHttpServer()).get('/api/v1/reports/inventory/valuation').set('Authorization', bmAuth).expect(200);
    expect(valuation.body.data[0]).not.toHaveProperty('averageCost');
    expect(valuation.body.data[0]).not.toHaveProperty('inventoryValue');
    expect(valuation.body.data[0]).toHaveProperty('quantityOnHand');
    expect(valuation.body.summary).not.toHaveProperty('inventoryValue');

    const movements = await request(app.getHttpServer()).get('/api/v1/reports/inventory/movements').set('Authorization', bmAuth).expect(200);
    expect(movements.body.data[0]).not.toHaveProperty('unitCostAtMovement');
    expect(movements.body.data[0]).not.toHaveProperty('movementValue');
    expect(movements.body.data[0]).toHaveProperty('quantityBase');
  });

  it('LOW STOCK is intentionally absent - no endpoint exists, because no reorder-point field exists to define "low"', async () => {
    await request(app.getHttpServer()).get('/api/v1/reports/inventory/low-stock').set('Authorization', auth()).expect(404);
  });
});
