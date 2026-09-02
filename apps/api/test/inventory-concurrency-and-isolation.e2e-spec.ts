import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupInventoryFixture, createSimpleProduct, InventoryFixture } from './utils/inventory-fixtures';
import { registerAndLogin } from './utils/register-and-login';

describe('Inventory: concurrency, tenant isolation, permissions (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let appRoleClient: PrismaClient;
  let biz: InventoryFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    appRoleClient = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
    biz = await setupInventoryFixture(app, 'concurrency');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await appRoleClient.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  describe('Real concurrency (actual parallel HTTP requests against the live server)', () => {
    it('exactly ONE of five simultaneous "sell the last unit" requests succeeds; the balance never goes negative', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RACE-LASTUNIT');
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 1, unitCost: 10 })
        .expect(201);

      const attempts = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app.getHttpServer())
            .post('/api/v1/inventory/consumptions')
            .set('Authorization', auth())
            .send({ referenceType: 'Sale', referenceId: 'fixture-sale', warehouseId: biz.warehouseId, variantId, quantity: 1 }),
        ),
      );

      const succeeded = attempts.filter((r) => r.status === 201);
      const rejected = attempts.filter((r) => r.status === 409);
      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(4);
      expect(rejected.every((r) => r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);

      const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
      expect(Number(balance.quantityOnHand)).toBe(0); // never -4, never negative at all

      const movements = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId, movementType: 'SALE' } });
      expect(movements).toBe(1); // only the one successful sale was ever recorded
    });

    it('ten concurrent sales of 3 units each against a stock of 20 never oversell: total consumed <= available', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RACE-PARTIAL');
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 5 })
        .expect(201);

      // 10 requests x 3 units = 30 requested against 20 available: at
      // most 6 can succeed (6*3=18, a 7th would need 21).
      const attempts = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app.getHttpServer())
            .post('/api/v1/inventory/consumptions')
            .set('Authorization', auth())
            .send({ referenceType: 'Sale', referenceId: 'fixture-sale', warehouseId: biz.warehouseId, variantId, quantity: 3 }),
        ),
      );

      const succeeded = attempts.filter((r) => r.status === 201);
      const totalConsumed = succeeded.length * 3;
      expect(totalConsumed).toBeLessThanOrEqual(20);

      const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
      expect(Number(balance.quantityOnHand)).toBe(20 - totalConsumed);
      expect(Number(balance.quantityOnHand)).toBeGreaterThanOrEqual(0); // the key property: never negative
    });

    it('concurrent purchases at different costs still land on the mathematically correct final weighted average (no lost updates)', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RACE-WAC');
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 10, unitCost: 10 })
        .expect(201); // 10 units @ 10 = 100 total value

      // Five concurrent purchases of 10 units at costs 10,20,30,40,50.
      const costs = [10, 20, 30, 40, 50];
      await Promise.all(
        costs.map((unitCost) =>
          request(app.getHttpServer())
            .post('/api/v1/inventory/receipts')
            .set('Authorization', auth())
            .send({ referenceType: 'PurchaseReceipt', referenceId: 'fixture-receipt', warehouseId: biz.warehouseId, variantId, quantity: 10, unitCost })
            .expect(201),
        ),
      );

      // Regardless of what order the row lock serialized these in, the
      // FINAL state must reflect every single one having been applied -
      // no lost update from two transactions racing on the same row.
      const totalQty = 10 + costs.length * 10; // 60
      const totalValue = 10 * 10 + costs.reduce((sum, c) => sum + c * 10, 0); // 100 + (100+200+300+400+500)
      const expectedAvg = totalValue / totalQty;

      const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
      expect(Number(balance.quantityOnHand)).toBe(totalQty);
      expect(Number(balance.averageCost)).toBeCloseTo(expectedAvg, 4);

      const movementCount = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId } });
      expect(movementCount).toBe(1 + costs.length); // opening + 5 receipts, none lost
    });
  });

  describe('Permission violations', () => {
    let cashierToken: string;
    let variantId: string;

    beforeAll(async () => {
      const cashierRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'CASHIER' } });
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'Cashier', email: `cashier@${biz.slug}.test`, password: 'CashierPass1!', roleIds: [cashierRole.id] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `cashier@${biz.slug}.test`, password: 'CashierPass1!', businessSlug: biz.slug })
        .expect(200);
      cashierToken = login.body.data.accessToken;

      ({ variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PERM-VARIANT'));
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 100, unitCost: 5 })
        .expect(201);
    });

    it('a Cashier (inventory.view only) can read balances but is forbidden from every write operation', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/balances?warehouseId=${biz.warehouseId}`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);

      const receive = await request(app.getHttpServer())
        .post('/api/v1/inventory/receipts')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ referenceType: 'PurchaseReceipt', referenceId: 'fixture-receipt', warehouseId: biz.warehouseId, variantId, quantity: 1, unitCost: 1 })
        .expect(403);
      expect(receive.body.error.code).toBe('FORBIDDEN');

      const consume = await request(app.getHttpServer())
        .post('/api/v1/inventory/consumptions')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ referenceType: 'Sale', referenceId: 'fixture-sale', warehouseId: biz.warehouseId, variantId, quantity: 1 })
        .expect(403);
      expect(consume.body.error.code).toBe('FORBIDDEN');

      const adjust = await request(app.getHttpServer())
        .post('/api/v1/inventory/adjustments')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ warehouseId: biz.warehouseId, variantId, quantity: -1, movementType: 'DAMAGE', reason: 'x' })
        .expect(403);
      expect(adjust.body.error.code).toBe('FORBIDDEN');

      const transfer = await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ sourceWarehouseId: biz.warehouseId, destinationWarehouseId: biz.warehouseId, items: [{ variantId, quantity: 1 }] })
        .expect(403);
      expect(transfer.body.error.code).toBe('FORBIDDEN');

      const count = await request(app.getHttpServer())
        .post('/api/v1/inventory/stock-counts')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ warehouseId: biz.warehouseId })
        .expect(403);
      expect(count.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('Tenant isolation', () => {
    let other: Awaited<ReturnType<typeof registerAndLogin>>;
    let variantId: string;

    beforeAll(async () => {
      other = await registerAndLogin(app, 'concurrency-other');
      ({ variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ISO-VARIANT'));
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 50, unitCost: 10 })
        .expect(201);
    });

    it('API layer: tenant B cannot see tenant A balances/movements, and cannot touch A stock by guessing ids', async () => {
      const balances = await request(app.getHttpServer())
        .get('/api/v1/inventory/balances')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(200);
      expect(balances.body.data.find((b: { variantId: string }) => b.variantId === variantId)).toBeUndefined();

      // Tenant B's own warehouseId won't resolve tenant A's variant.
      const receive = await request(app.getHttpServer())
        .post('/api/v1/inventory/receipts')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ referenceType: 'PurchaseReceipt', referenceId: 'fixture-receipt', warehouseId: other.warehouseId, variantId, quantity: 1, unitCost: 1 })
        .expect(404);
      expect(receive.body.error.code).toBe('NOT_FOUND');
    });

    it('DB layer: a raw unfiltered query against stock_movements/stock_balances as erp_app returns zero rows with no tenant context', async () => {
      const movements = await appRoleClient.$queryRawUnsafe<unknown[]>('SELECT * FROM stock_movements');
      expect(movements.length).toBe(0);
      const balances = await appRoleClient.$queryRawUnsafe<unknown[]>('SELECT * FROM stock_balances');
      expect(balances.length).toBe(0);
    });

    it('DB layer: setting context to A returns only A rows from an unfiltered query, never B', async () => {
      const rows = await appRoleClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
        return tx.$queryRawUnsafe<{ business_id: string }[]>('SELECT business_id FROM stock_movements');
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.business_id === biz.businessId)).toBe(true);
    });

    it('DB layer: stock_movements is truly append-only - erp_app has no UPDATE or DELETE privilege at all', async () => {
      const anyMovement = await admin.stockMovement.findFirstOrThrow({ where: { businessId: biz.businessId } });

      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
          await tx.$executeRawUnsafe(`UPDATE stock_movements SET reason = 'tampered' WHERE id = '${anyMovement.id}'`);
        }),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
          await tx.$executeRawUnsafe(`DELETE FROM stock_movements WHERE id = '${anyMovement.id}'`);
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it('DB layer: erp_app cannot insert a stock_movements row for tenant A while context is set to tenant B (RLS WITH CHECK rejects it)', async () => {
      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${other.businessId}'`);
          await tx.$executeRawUnsafe(
            `INSERT INTO stock_movements (id, business_id, branch_id, warehouse_id, variant_id, movement_type, quantity_base, unit_cost_at_movement, created_at)
             VALUES ('${randomUUID()}', '${biz.businessId}', '${biz.branchId}', '${biz.warehouseId}', '${variantId}', 'ADJUSTMENT', 1, 0, NOW())`,
          );
        }),
      ).rejects.toThrow();
    });
  });
});
