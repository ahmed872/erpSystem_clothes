import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';
import { registerAndLogin } from './utils/register-and-login';

describe('Sales: concurrency, permissions, tenant isolation (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let appRoleClient: PrismaClient;
  let biz: SalesFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    appRoleClient = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'sconcurrency');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await appRoleClient.$disconnect();
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

  function sellRequest(items: { variantId: string; quantity: number; unitPrice: number }[], extra: Record<string, unknown> = {}) {
    const total = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items, payments: [{ amount: total }], ...extra });
  }

  describe('Real concurrency', () => {
    it('LAST UNIT: exactly one of five simultaneous sales of the last unit succeeds, balance never goes negative', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SCONC-LASTUNIT-1');
      await stockUp(variantId, 1, 5);

      const results = await Promise.all(Array.from({ length: 5 }, () => sellRequest([{ variantId, quantity: 1, unitPrice: 10 }])));
      const succeeded = results.filter((r) => r.status === 201);
      const failed = results.filter((r) => r.status === 409);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(4);
      expect(failed.every((r) => r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);

      const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
      expect(Number(balance.quantityOnHand)).toBe(0); // never negative

      const movementCount = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId, movementType: 'SALE' } });
      expect(movementCount).toBe(1);
    });

    it('MULTI-UNIT: ten concurrent sales of 3 units each against a 20-unit balance never oversell; final balance is exact', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SCONC-MULTIUNIT-1');
      await stockUp(variantId, 20, 5);

      const results = await Promise.all(Array.from({ length: 10 }, () => sellRequest([{ variantId, quantity: 3, unitPrice: 10 }])));
      const succeeded = results.filter((r) => r.status === 201).length;
      expect(succeeded).toBeGreaterThan(0);
      expect(succeeded).toBeLessThanOrEqual(6); // floor(20/3)

      const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
      expect(Number(balance.quantityOnHand)).toBe(20 - succeeded * 3); // exact, no lost update
      expect(Number(balance.quantityOnHand)).toBeGreaterThanOrEqual(0);
    });

    it('SHARED-VARIANT ORDERING: two concurrent multi-line sales selling the SAME two variants in OPPOSITE input order both succeed with no deadlock and no lost update', async () => {
      const { variantId: x } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SCONC-ORDER-X');
      const { variantId: y } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SCONC-ORDER-Y');
      await stockUp(x, 20, 5);
      await stockUp(y, 20, 5);

      const [resA, resB] = await Promise.all([
        sellRequest([
          { variantId: x, quantity: 2, unitPrice: 10 },
          { variantId: y, quantity: 2, unitPrice: 10 },
        ]),
        sellRequest([
          { variantId: y, quantity: 3, unitPrice: 10 },
          { variantId: x, quantity: 3, unitPrice: 10 },
        ]),
      ]);
      // Plenty of stock for both - both must succeed; a lock-order
      // inversion between the two differently-ordered requests would
      // either deadlock (Postgres would abort one with 55P03, surfacing
      // as a request failure here) or hang the test past its timeout.
      expect(resA.status).toBe(201);
      expect(resB.status).toBe(201);

      const balanceX = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: x } });
      expect(Number(balanceX.quantityOnHand)).toBe(20 - 2 - 3);
      const balanceY = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: y } });
      expect(Number(balanceY.quantityOnHand)).toBe(20 - 2 - 3);
    });

    it('BUNDLE CONTENTION: two concurrent bundle sales competing for a scarce shared component - only what stock allows succeeds, no over-consumption', async () => {
      const { variantId: componentId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SCONC-BUNDLE-COMPONENT-1');
      await stockUp(componentId, 5, 3); // only 5 units of the scarce component

      const bundle = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'SCONC-BUNDLE-1', name: 'Contention Bundle', type: 'BUNDLE', baseUomId: biz.uomId, bundleItems: [{ variantId: componentId, quantity: 3 }] })
        .expect(201);
      const bundleVariantId = bundle.body.data.variants[0].id;

      // Two concurrent sales of 1 bundle each (needs 3 components each,
      // 6 total requested, only 5 available) - only one can succeed.
      const results = await Promise.all([
        sellRequest([{ variantId: bundleVariantId, quantity: 1, unitPrice: 50 }]),
        sellRequest([{ variantId: bundleVariantId, quantity: 1, unitPrice: 50 }]),
      ]);
      const succeeded = results.filter((r) => r.status === 201);
      expect(succeeded).toHaveLength(1);

      const componentBalance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: componentId } });
      expect(Number(componentBalance.quantityOnHand)).toBe(2); // 5 - 3, never 5 - 6
    });

    it('SALE + RETURN: a concurrent new sale and a return of a different, earlier sale on the SAME variant never corrupt the balance', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SCONC-SALERETURN-1');
      await stockUp(variantId, 20, 5);

      // An earlier, already-completed sale to return from.
      const earlier = await sellRequest([{ variantId, quantity: 4, unitPrice: 10 }]).expect(201);
      const earlierItemId = earlier.body.data.items[0].id;
      const balanceAfterEarlierSale = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
      expect(Number(balanceAfterEarlierSale.quantityOnHand)).toBe(16); // 20 - 4

      const [newSaleRes, returnRes] = await Promise.all([
        sellRequest([{ variantId, quantity: 5, unitPrice: 10 }]),
        request(app.getHttpServer())
          .post(`/api/v1/sales/${earlier.body.data.id}/returns`)
          .set('Authorization', auth())
          .send({ items: [{ saleItemId: earlierItemId, quantity: 2, condition: 'SELLABLE' }] }),
      ]);
      expect(newSaleRes.status).toBe(201);
      expect(returnRes.status).toBe(201);

      const finalBalance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
      // 16 (after earlier sale) - 5 (new sale) + 2 (return) = 13, regardless
      // of which of the two concurrent operations the row lock serialized first.
      expect(Number(finalBalance.quantityOnHand)).toBe(13);

      const movementCount = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId } });
      expect(movementCount).toBe(4); // opening + earlier sale + new sale + return
    });

    it('RETURN + RETURN: two concurrent return requests against the SAME sale line, together exceeding what was sold, serialize correctly - exactly one over-limit request is rejected, never over-returned', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SCONC-RETURN-1');
      await stockUp(variantId, 20, 5);
      const sale = await sellRequest([{ variantId, quantity: 10, unitPrice: 10 }]).expect(201);
      const saleItemId = sale.body.data.items[0].id;

      // Two concurrent returns of 6 each against only 10 sold (12 total
      // requested) - the same Sale-row lock (`lockSale`) that serializes
      // concurrent late payments must also serialize this.
      const results = await Promise.all(
        [6, 6].map((qty) =>
          request(app.getHttpServer())
            .post(`/api/v1/sales/${sale.body.data.id}/returns`)
            .set('Authorization', auth())
            .send({ items: [{ saleItemId, quantity: qty }] }),
        ),
      );
      const succeeded = results.filter((r) => r.status === 201);
      const failed = results.filter((r) => r.status === 409);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);

      const saleItem = await admin.saleItem.findUniqueOrThrow({ where: { id: saleItemId } });
      expect(Number(saleItem.quantityReturned)).toBe(6); // never 12

      const returnMovementCount = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId, movementType: 'SALES_RETURN' } });
      expect(returnMovementCount).toBe(1); // the rejected one left no trace
    });

    it('DUPLICATE IDEMPOTENCY: two truly simultaneous sale requests with the SAME idempotencyKey never both apply - exactly one succeeds, one inventory effect', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SCONC-IDEMP-1');
      await stockUp(variantId, 20, 5);
      const idempotencyKey = `race-sale-idempotency-${randomUUID()}`;

      const results = await Promise.all([
        sellRequest([{ variantId, quantity: 2, unitPrice: 10 }], { idempotencyKey }),
        sellRequest([{ variantId, quantity: 2, unitPrice: 10 }], { idempotencyKey }),
      ]);
      const succeeded = results.filter((r) => r.status === 201);
      expect(succeeded.length).toBe(1);

      const movementCount = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId, movementType: 'SALE' } });
      expect(movementCount).toBe(1);
      const saleCount = await admin.sale.count({ where: { businessId: biz.businessId, idempotencyKey } });
      expect(saleCount).toBe(1);
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
        .send({ name: 'Perm Cashier', email: `permcashier@${biz.slug}.test`, password: 'CashierPass1!', roleIds: [cashierRole.id] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `permcashier@${biz.slug}.test`, password: 'CashierPass1!', businessSlug: biz.slug })
        .expect(200);
      cashierToken = login.body.data.accessToken;

      ({ variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SCONC-PERM-1'));
      await stockUp(variantId, 10, 5);
    });

    it('a Cashier CAN sell (has sales.create + shifts.open/close) but is FORBIDDEN from actions outside their template (e.g. editing another user)', async () => {
      const openShift = await request(app.getHttpServer())
        .post('/api/v1/sales/shifts/open')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ warehouseId: biz.warehouseId })
        .expect(201);
      expect(openShift.body.data.status).toBe('OPEN');

      const sale = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 10 }], payments: [{ amount: 10 }] })
        .expect(201);
      expect(sale.body.data.status).toBe('COMPLETED');

      await request(app.getHttpServer()).post('/api/v1/sales/shifts/close').set('Authorization', `Bearer ${cashierToken}`).expect(200);

      const forbidden = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ name: 'x', email: `x@${biz.slug}.test`, password: 'Pass1234!', roleIds: [] })
        .expect(403);
      expect(forbidden.body.error.code).toBe('FORBIDDEN');
    });

    it('a user with no sales permissions at all (INVENTORY_MANAGER template) is forbidden from every sales route', async () => {
      const invMgrRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'INVENTORY_MANAGER' } });
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'No Perms', email: `noperms@${biz.slug}.test`, password: 'NoPermsPass1!', roleIds: [invMgrRole.id] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `noperms@${biz.slug}.test`, password: 'NoPermsPass1!', businessSlug: biz.slug })
        .expect(200);
      const token = login.body.data.accessToken;

      const list = await request(app.getHttpServer()).get('/api/v1/sales').set('Authorization', `Bearer ${token}`).expect(403);
      expect(list.body.error.code).toBe('FORBIDDEN');

      const create = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 10 }], payments: [{ amount: 10 }] })
        .expect(403);
      expect(create.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('Tenant isolation', () => {
    let other: Awaited<ReturnType<typeof registerAndLogin>>;
    let variantId: string;
    let saleId: string;

    beforeAll(async () => {
      other = await registerAndLogin(app, 'sales-other');
      ({ variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'SCONC-ISO-1'));
      await stockUp(variantId, 10, 5);
      const sale = await sellRequest([{ variantId, quantity: 1, unitPrice: 10 }]).expect(201);
      saleId = sale.body.data.id;
    });

    it('API layer: tenant B cannot see tenant A sales/customers, and cannot act on A sale ids by guessing', async () => {
      // Tenant B's owner has sales.view (BUSINESS_OWNER gets everything),
      // so the list call succeeds (200) but must never contain A's data.
      const list = await request(app.getHttpServer()).get('/api/v1/sales').set('Authorization', `Bearer ${other.accessToken}`).expect(200);
      expect(list.body.data.find((s: { id: string }) => s.id === saleId)).toBeUndefined();

      const get = await request(app.getHttpServer()).get(`/api/v1/sales/${saleId}`).set('Authorization', `Bearer ${other.accessToken}`).expect(404);
      expect(get.body.error.code).toBe('NOT_FOUND');

      const ret = await request(app.getHttpServer())
        .post(`/api/v1/sales/${saleId}/returns`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ items: [{ saleItemId: '00000000-0000-0000-0000-000000000000', quantity: 1 }] })
        .expect(404);
      expect(ret.body.error.code).toBe('NOT_FOUND');
    });

    it('DB layer: a raw unfiltered query against sales/customers as erp_app returns zero rows with no tenant context', async () => {
      const sales = await appRoleClient.$queryRawUnsafe<unknown[]>('SELECT * FROM sales');
      expect(sales.length).toBe(0);
      const customers = await appRoleClient.$queryRawUnsafe<unknown[]>('SELECT * FROM customers');
      expect(customers.length).toBe(0);
    });

    it('DB layer: setting context to A returns only A rows, never B', async () => {
      const rows = await appRoleClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
        return tx.$queryRawUnsafe<{ business_id: string }[]>('SELECT business_id FROM sales');
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.business_id === biz.businessId)).toBe(true);
    });

    it('DB layer: customer_transactions is truly append-only - erp_app has no UPDATE or DELETE privilege', async () => {
      const customer = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: 'Ledger Integrity Customer' }).expect(201);
      await sellRequest([{ variantId, quantity: 1, unitPrice: 10 }], { customerId: customer.body.data.id, payments: [] }).expect(201);
      const anyTxn = await admin.customerTransaction.findFirstOrThrow({ where: { businessId: biz.businessId, customerId: customer.body.data.id } });

      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
          await tx.$executeRawUnsafe(`UPDATE customer_transactions SET description = 'tampered' WHERE id = '${anyTxn.id}'`);
        }),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
          await tx.$executeRawUnsafe(`DELETE FROM customer_transactions WHERE id = '${anyTxn.id}'`);
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it('DB layer: erp_app cannot insert a sales row for tenant A while context is set to tenant B (RLS WITH CHECK rejects it)', async () => {
      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${other.businessId}'`);
          await tx.$executeRawUnsafe(
            `INSERT INTO sales (id, business_id, branch_id, warehouse_id, shift_id, sale_number, status, subtotal, discount_amount, tax_amount, total_amount, created_at, updated_at)
             VALUES ('${randomUUID()}', '${biz.businessId}', '${biz.branchId}', '${biz.warehouseId}', '${biz.activeShiftId}', 'INV-HACK0001', 'COMPLETED', 0, 0, 0, 0, NOW(), NOW())`,
          );
        }),
      ).rejects.toThrow();
    });
  });
});
