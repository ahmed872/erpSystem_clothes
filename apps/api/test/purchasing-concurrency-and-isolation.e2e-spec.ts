import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupPurchasingFixture, createApprovedPurchase, PurchasingFixture } from './utils/purchasing-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';
import { registerAndLogin } from './utils/register-and-login';

describe('Purchasing: concurrency, permissions, tenant isolation (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let appRoleClient: PrismaClient;
  let biz: PurchasingFixture;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    appRoleClient = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
    biz = await setupPurchasingFixture(app, 'pconcurrency');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await appRoleClient.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function getItemId(purchaseId: string, variantId: string): Promise<string> {
    const purchase = await request(app.getHttpServer()).get(`/api/v1/purchasing/purchases/${purchaseId}`).set('Authorization', auth()).expect(200);
    return purchase.body.data.items.find((i: { variantId: string }) => i.variantId === variantId).id;
  }

  describe('Real concurrency', () => {
    it('two simultaneous receive requests for the same Purchase, together exceeding quantityOrdered, serialize correctly: exactly one over-limit request is rejected, the item is never over-received', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RACE-RECEIVE-1');
      const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 10, unitCost: 5 }]);
      const itemId = await getItemId(purchaseId, variantId);

      // Two concurrent requests each asking for 6 - only one combination
      // (6 then remaining 4, or the reverse) can be fully satisfied
      // without exceeding 10. The Purchase-row lock must serialize these
      // rather than let both read "10 remaining" and both succeed with 6
      // each (which would over-receive to 12).
      const results = await Promise.all(
        [6, 6].map((qty) =>
          request(app.getHttpServer())
            .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
            .set('Authorization', auth())
            .send({ items: [{ purchaseItemId: itemId, quantityReceived: qty }] }),
        ),
      );

      const succeeded = results.filter((r) => r.status === 201);
      const failed = results.filter((r) => r.status === 409);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);

      const purchaseItem = await admin.purchaseItem.findFirstOrThrow({ where: { purchaseId, variantId } });
      expect(Number(purchaseItem.quantityReceived)).toBe(6); // never 12

      const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
      expect(Number(balance.quantityOnHand)).toBe(6);

      const movementCount = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId, movementType: 'PURCHASE' } });
      expect(movementCount).toBe(1); // the rejected one left no trace
    });

    it('two concurrent receive requests that together exactly consume the outstanding quantity both succeed with no lost update', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RACE-RECEIVE-2');
      const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 10, unitCost: 5 }]);
      const itemId = await getItemId(purchaseId, variantId);

      const results = await Promise.all(
        [5, 5].map((qty) =>
          request(app.getHttpServer())
            .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
            .set('Authorization', auth())
            .send({ items: [{ purchaseItemId: itemId, quantityReceived: qty }] }),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);

      const purchaseItem = await admin.purchaseItem.findFirstOrThrow({ where: { purchaseId, variantId } });
      expect(Number(purchaseItem.quantityReceived)).toBe(10);

      const purchase = await admin.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
      expect(purchase.status).toBe('RECEIVED');

      const movementCount = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId, movementType: 'PURCHASE' } });
      expect(movementCount).toBe(2);
    });

    it('two TRULY SIMULTANEOUS receive requests with the SAME idempotencyKey never both apply inventory: exactly one succeeds, the other fails without a second movement', async () => {
      // Unlike the sequential idempotency test in purchasing-receiving.e2e-spec.ts
      // (which proves a RETRY after the first commits returns the original
      // receipt), this proves the harder case: two requests racing for the
      // SAME unique (businessId, idempotencyKey) slot with neither having
      // committed yet when the second starts. The receiving use case checks
      // for an existing receipt BEFORE taking any lock, so both requests can
      // pass that check; the actual safety net is the unique index on
      // purchase_receipts(business_id, idempotency_key), which Postgres
      // enforces even under two genuinely concurrent inserts - the second
      // INSERT blocks until the first commits, then fails with a unique
      // violation (mapped to 409 CONFLICT) rather than silently succeeding.
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RACE-IDEMP-1');
      const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 10, unitCost: 7 }]);
      const itemId = await getItemId(purchaseId, variantId);
      const idempotencyKey = `race-idempotency-${randomUUID()}`;

      const results = await Promise.all(
        [1, 2].map(() =>
          request(app.getHttpServer())
            .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
            .set('Authorization', auth())
            .send({ items: [{ purchaseItemId: itemId, quantityReceived: 10 }], idempotencyKey }),
        ),
      );

      const succeeded = results.filter((r) => r.status === 201);
      const failed = results.filter((r) => r.status !== 201);
      // Exactly one request creates the receipt; the other is rejected by
      // the unique constraint (never a silent second success).
      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);

      const movementCount = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId, movementType: 'PURCHASE' } });
      expect(movementCount).toBe(1); // inventory applied exactly once, never twice

      const receiptCount = await admin.purchaseReceipt.count({ where: { businessId: biz.businessId, idempotencyKey } });
      expect(receiptCount).toBe(1);

      const purchaseItem = await admin.purchaseItem.findFirstOrThrow({ where: { purchaseId, variantId } });
      expect(Number(purchaseItem.quantityReceived)).toBe(10); // never 20
    });

    it('two concurrent RETURN requests for the same Purchase, together exceeding what was received, serialize correctly: exactly one over-limit request is rejected, the item is never over-returned', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'RACE-RETURN-1');
      const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 10, unitCost: 4 }]);
      const itemId = await getItemId(purchaseId, variantId);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
        .set('Authorization', auth())
        .send({ items: [{ purchaseItemId: itemId, quantityReceived: 10 }] })
        .expect(201);

      // Two concurrent returns of 6 each against only 10 received (12
      // total requested) - the SAME Purchase-row lock that serializes
      // concurrent receiving (tested above) must also serialize this.
      const results = await Promise.all(
        [6, 6].map((qty) =>
          request(app.getHttpServer())
            .post(`/api/v1/purchasing/purchases/${purchaseId}/returns`)
            .set('Authorization', auth())
            .send({ items: [{ purchaseItemId: itemId, quantity: qty }] }),
        ),
      );

      const succeeded = results.filter((r) => r.status === 201);
      const failed = results.filter((r) => r.status === 409);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);

      const purchaseItem = await admin.purchaseItem.findFirstOrThrow({ where: { purchaseId, variantId } });
      expect(Number(purchaseItem.quantityReturned)).toBe(6); // never 12

      const balance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });
      expect(Number(balance.quantityOnHand)).toBe(4); // 10 received - 6 returned, never 10-12

      const returnMovementCount = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId, movementType: 'PURCHASE_RETURN' } });
      expect(returnMovementCount).toBe(1); // the rejected one left no trace
    });
  });

  describe('Permission violations', () => {
    let cashierToken: string;
    let inventoryManagerToken: string;
    let variantId: string;
    let approvedPurchaseId: string;

    beforeAll(async () => {
      const cashierRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'CASHIER' } });
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'Cashier', email: `cashier@${biz.slug}.test`, password: 'CashierPass1!', roleIds: [cashierRole.id] })
        .expect(201);
      const cashierLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `cashier@${biz.slug}.test`, password: 'CashierPass1!', businessSlug: biz.slug })
        .expect(200);
      cashierToken = cashierLogin.body.data.accessToken;

      const invMgrRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'INVENTORY_MANAGER' } });
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'Inv Mgr', email: `invmgr@${biz.slug}.test`, password: 'InvMgrPass1!', roleIds: [invMgrRole.id] })
        .expect(201);
      const invMgrLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `invmgr@${biz.slug}.test`, password: 'InvMgrPass1!', businessSlug: biz.slug })
        .expect(200);
      inventoryManagerToken = invMgrLogin.body.data.accessToken;

      ({ variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'PERM-VARIANT-1'));
      approvedPurchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 10, unitCost: 5 }]);
    });

    it('a Cashier (no purchasing permissions at all) is forbidden from every purchasing read and write route', async () => {
      const list = await request(app.getHttpServer()).get('/api/v1/purchasing/suppliers').set('Authorization', `Bearer ${cashierToken}`).expect(403);
      expect(list.body.error.code).toBe('FORBIDDEN');

      const create = await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ warehouseId: biz.warehouseId, supplierId: biz.supplierId, items: [{ variantId, quantityOrdered: 1, unitCost: 1 }] })
        .expect(403);
      expect(create.body.error.code).toBe('FORBIDDEN');

      const itemId = await getItemId(approvedPurchaseId, variantId);
      const receive = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${approvedPurchaseId}/receive`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ items: [{ purchaseItemId: itemId, quantityReceived: 1 }] })
        .expect(403);
      expect(receive.body.error.code).toBe('FORBIDDEN');
    });

    it('an Inventory Manager can create/receive/return purchases but is forbidden from approve/cancel/pay (elevated financial actions)', async () => {
      const create = await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', `Bearer ${inventoryManagerToken}`)
        .send({ warehouseId: biz.warehouseId, supplierId: biz.supplierId, items: [{ variantId, quantityOrdered: 2, unitCost: 3 }] })
        .expect(201);
      const purchaseId = create.body.data.id;

      const approveForbidden = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${purchaseId}/approve`)
        .set('Authorization', `Bearer ${inventoryManagerToken}`)
        .expect(403);
      expect(approveForbidden.body.error.code).toBe('FORBIDDEN');

      // Owner approves it so the Inventory Manager can exercise receive.
      await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${purchaseId}/approve`).set('Authorization', auth()).expect(200);

      const itemId = await getItemId(purchaseId, variantId);
      const receive = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
        .set('Authorization', `Bearer ${inventoryManagerToken}`)
        .send({ items: [{ purchaseItemId: itemId, quantityReceived: 2 }] })
        .expect(201);
      expect(receive.body.data.items).toHaveLength(1);

      const returnAllowed = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${purchaseId}/returns`)
        .set('Authorization', `Bearer ${inventoryManagerToken}`)
        .send({ items: [{ purchaseItemId: itemId, quantity: 1 }] })
        .expect(201);
      expect(returnAllowed.body.data.items).toHaveLength(1);

      const payForbidden = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${purchaseId}/payments`)
        .set('Authorization', `Bearer ${inventoryManagerToken}`)
        .send({ amount: 1 })
        .expect(403);
      expect(payForbidden.body.error.code).toBe('FORBIDDEN');

      const cancelForbidden = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${purchaseId}/cancel`)
        .set('Authorization', `Bearer ${inventoryManagerToken}`)
        .send({})
        .expect(403);
      expect(cancelForbidden.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('Tenant isolation', () => {
    let other: Awaited<ReturnType<typeof registerAndLogin>>;
    let variantId: string;
    let purchaseId: string;

    beforeAll(async () => {
      other = await registerAndLogin(app, 'purchasing-other');
      ({ variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ISO-PURCHASE-1'));
      purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId, quantityOrdered: 5, unitCost: 1 }]);
    });

    it('API layer: tenant B cannot see tenant A suppliers/purchases, and cannot act on A purchase ids by guessing', async () => {
      const suppliers = await request(app.getHttpServer())
        .get('/api/v1/purchasing/suppliers')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(200);
      expect(suppliers.body.data.find((s: { id: string }) => s.id === biz.supplierId)).toBeUndefined();

      const getSupplier = await request(app.getHttpServer())
        .get(`/api/v1/purchasing/suppliers/${biz.supplierId}`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(404);
      expect(getSupplier.body.error.code).toBe('NOT_FOUND');

      const getPurchase = await request(app.getHttpServer())
        .get(`/api/v1/purchasing/purchases/${purchaseId}`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(404);
      expect(getPurchase.body.error.code).toBe('NOT_FOUND');

      const approve = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${purchaseId}/approve`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(404);
      expect(approve.body.error.code).toBe('NOT_FOUND');
    });

    it('DB layer: a raw unfiltered query against suppliers/purchases as erp_app returns zero rows with no tenant context', async () => {
      const suppliers = await appRoleClient.$queryRawUnsafe<unknown[]>('SELECT * FROM suppliers');
      expect(suppliers.length).toBe(0);
      const purchases = await appRoleClient.$queryRawUnsafe<unknown[]>('SELECT * FROM purchases');
      expect(purchases.length).toBe(0);
    });

    it('DB layer: setting context to A returns only A rows, never B', async () => {
      const rows = await appRoleClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
        return tx.$queryRawUnsafe<{ business_id: string }[]>('SELECT business_id FROM purchases');
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.business_id === biz.businessId)).toBe(true);
    });

    it('DB layer: supplier_transactions is truly append-only - erp_app has no UPDATE or DELETE privilege', async () => {
      const anyTxn = await admin.supplierTransaction.findFirstOrThrow({ where: { businessId: biz.businessId } });

      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
          await tx.$executeRawUnsafe(`UPDATE supplier_transactions SET description = 'tampered' WHERE id = '${anyTxn.id}'`);
        }),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
          await tx.$executeRawUnsafe(`DELETE FROM supplier_transactions WHERE id = '${anyTxn.id}'`);
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it('DB layer: erp_app cannot insert a purchases row for tenant A while context is set to tenant B (RLS WITH CHECK rejects it)', async () => {
      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${other.businessId}'`);
          await tx.$executeRawUnsafe(
            `INSERT INTO purchases (id, business_id, branch_id, warehouse_id, supplier_id, purchase_number, status, created_at, updated_at)
             VALUES ('${randomUUID()}', '${biz.businessId}', '${biz.branchId}', '${biz.warehouseId}', '${biz.supplierId}', 'PO-HACK0001', 'DRAFT', NOW(), NOW())`,
          );
        }),
      ).rejects.toThrow();
    });
  });
});
