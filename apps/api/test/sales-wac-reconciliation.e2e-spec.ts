import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * End-to-end WAC/historical-cost reconciliation across Inventory,
 * Purchasing, and Sales together - the exact chain the Phase 5 review
 * asked for: Opening Stock -> Purchase -> Sale -> Purchase -> Sale ->
 * Return -> Adjustment, verifying every historical StockMovement's
 * unit_cost_at_movement stays exactly what it was recorded as, even
 * after every later operation that changes the CURRENT average cost.
 */
describe('Sales: WAC / historical cost reconciliation across Inventory + Purchasing + Sales (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'wac-reconciliation');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  it('every historical movement cost remains stable through Opening -> Purchase -> Sale -> Purchase -> Sale -> Return -> Adjustment', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'WAC-CHAIN-1');

    // 1) Opening stock: 10 @ 5 -> qty 10, avg 5
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 10, unitCost: 5 })
      .expect(201);

    // 2) Purchase (receive) 10 @ 10 -> qty 20, avg (10*5+10*10)/20 = 7.5
    await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 10, unitCost: 10 })
      .expect(201);
    let balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balance.averageCost)).toBeCloseTo(7.5, 4);

    // 3) Sale 5 units -> COGS locked at current avg 7.5, qty 15, avg unchanged
    const sale1 = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 5, unitPrice: 50 }], payments: [{ amount: 250 }] })
      .expect(201);
    const sale1Movement = await admin.stockMovement.findFirstOrThrow({
      where: { businessId: biz.businessId, variantId, movementType: 'SALE', referenceType: 'Sale', referenceId: sale1.body.data.id },
    });
    expect(Number(sale1Movement.unitCostAtMovement)).toBeCloseTo(7.5, 4);
    balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balance.quantityOnHand)).toBe(15);
    expect(Number(balance.averageCost)).toBeCloseTo(7.5, 4); // a decrease never changes the average

    // 4) Purchase again: 10 @ 20 -> qty 25, avg (15*7.5 + 10*20)/25 = 12.5
    await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 10, unitCost: 20 })
      .expect(201);
    balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balance.averageCost)).toBeCloseTo(12.5, 4);

    // The FIRST sale's recorded cost must be untouched by this later purchase.
    const sale1MovementReread = await admin.stockMovement.findUniqueOrThrow({ where: { id: sale1Movement.id } });
    expect(Number(sale1MovementReread.unitCostAtMovement)).toBeCloseTo(7.5, 4);

    // 5) Sale again: 5 units -> COGS locked at current avg 12.5, qty 20
    const sale2 = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 5, unitPrice: 60 }], payments: [{ amount: 300 }] })
      .expect(201);
    const sale2ItemId = sale2.body.data.items[0].id;
    const sale2Movement = await admin.stockMovement.findFirstOrThrow({
      where: { businessId: biz.businessId, variantId, movementType: 'SALE', referenceType: 'Sale', referenceId: sale2.body.data.id },
    });
    expect(Number(sale2Movement.unitCostAtMovement)).toBeCloseTo(12.5, 4);
    balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balance.quantityOnHand)).toBe(20);
    expect(Number(balance.averageCost)).toBeCloseTo(12.5, 4);

    // 6) Return 2 units (SELLABLE) from the SECOND sale -> must carry over
    // sale2's OWN cost (12.5), not whatever the average is by return time.
    const ret = await request(app.getHttpServer())
      .post(`/api/v1/sales/${sale2.body.data.id}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId: sale2ItemId, quantity: 2, condition: 'SELLABLE' }] })
      .expect(201);
    const returnMovement = await admin.stockMovement.findFirstOrThrow({
      where: { businessId: biz.businessId, variantId, movementType: 'SALES_RETURN', referenceType: 'SaleReturn', referenceId: ret.body.data.id },
    });
    expect(Number(returnMovement.unitCostAtMovement)).toBeCloseTo(12.5, 4);
    balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balance.quantityOnHand)).toBe(22); // 20 + 2
    // A return increase re-blends into the average per the standard WAC
    // formula: (20*12.5 + 2*12.5) / 22 = 12.5 (same cost in, no change).
    expect(Number(balance.averageCost)).toBeCloseTo(12.5, 4);

    // 7) Adjustment: DAMAGE -2 units -> COGS at current avg (12.5), never
    // touches any of the prior movements' recorded costs.
    await request(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: -2, movementType: 'DAMAGE', reason: 'reconciliation test damage' })
      .expect(201);
    const damageMovement = await admin.stockMovement.findFirstOrThrow({
      where: { businessId: biz.businessId, variantId, movementType: 'DAMAGE', reason: 'reconciliation test damage' },
    });
    expect(Number(damageMovement.unitCostAtMovement)).toBeCloseTo(12.5, 4);
    balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
    expect(Number(balance.quantityOnHand)).toBe(20); // 22 - 2
    expect(Number(balance.averageCost)).toBeCloseTo(12.5, 4); // a decrease never changes the average

    // FINAL RECONCILIATION: every historical movement's cost, re-read
    // fresh at the very end after every subsequent operation, is exactly
    // what it was recorded as at the time - proving unit_cost_at_movement
    // is truly immutable across the whole chain, not just the two direct
    // spot-checks above.
    const openingMovement = await admin.stockMovement.findFirstOrThrow({ where: { businessId: biz.businessId, variantId, movementType: 'OPENING_BALANCE' } });
    expect(Number(openingMovement.unitCostAtMovement)).toBe(5);
    const firstReceiptMovement = await admin.stockMovement.findFirstOrThrow({ where: { businessId: biz.businessId, variantId, movementType: 'PURCHASE', unitCostAtMovement: 10 } });
    expect(Number(firstReceiptMovement.unitCostAtMovement)).toBe(10);
    const secondReceiptMovement = await admin.stockMovement.findFirstOrThrow({ where: { businessId: biz.businessId, variantId, movementType: 'PURCHASE', unitCostAtMovement: 20 } });
    expect(Number(secondReceiptMovement.unitCostAtMovement)).toBe(20);
    const sale1Final = await admin.stockMovement.findUniqueOrThrow({ where: { id: sale1Movement.id } });
    expect(Number(sale1Final.unitCostAtMovement)).toBeCloseTo(7.5, 4);
    const sale2Final = await admin.stockMovement.findUniqueOrThrow({ where: { id: sale2Movement.id } });
    expect(Number(sale2Final.unitCostAtMovement)).toBeCloseTo(12.5, 4);

    // Ledger reconciliation: SUM(quantity_base) from stock_movements must
    // equal the cached StockBalance.quantityOnHand exactly (Phase 3's
    // reconciliation guarantee, still holding after this whole chain).
    const reconciliation = await request(app.getHttpServer()).get('/api/v1/inventory/reconciliation').set('Authorization', auth()).expect(200);
    const discrepancy = reconciliation.body.data.discrepancies.find((d: { variantId: string }) => d.variantId === variantId);
    expect(discrepancy).toBeUndefined();
  });
});
