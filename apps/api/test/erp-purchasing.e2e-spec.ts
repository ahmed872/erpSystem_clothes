import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupInventoryFixture, InventoryFixture, createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 16 — ERP PURCHASING + SUPPLIERS.
 *
 * WHAT THIS SPEC IS FOR. The purchasing contracts already existed and the
 * ERP added none; `purchasing-lifecycle`, `purchasing-receiving`,
 * `purchasing-returns`, `purchasing-suppliers` and
 * `purchasing-concurrency-and-isolation` already prove the engine works.
 * What was NOT proved is the set of claims the ERP purchasing screens
 * make:
 *
 *   - purchasing carries NO protected cost (the Phase 14/15 defect class)
 *     — verified as a NEGATIVE result, not assumed from the earlier fixes;
 *   - purchasing splits across THREE roles, so nobody can run an order
 *     end to end alone;
 *   - receiving writes exactly one movement, one receipt and one balanced
 *     journal entry, and a replayed idempotency key receives nothing more;
 *   - the lifecycle refuses every transition the screens do not offer;
 *   - serials are the server's, at receipt and at return;
 *   - none of it crosses a tenant boundary.
 */
describe('ERP purchasing (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: InventoryFixture;
  let other: InventoryFixture;

  let ownerToken: string;
  /** INVENTORY_MANAGER: raises and receives, cannot approve or pay. */
  let buyerToken: string;
  /** BRANCH_MANAGER: approves and cancels, cannot raise or receive. */
  let approverToken: string;
  /** ACCOUNTANT: pays, and nothing else. */
  let payerToken: string;
  /** A CUSTOM role with full purchasing rights but NOT products.view_cost. */
  let noCostToken: string;
  /** A CUSTOM role that may only read. */
  let viewerToken: string;

  let supplierId: string;
  let variantId: string;
  let serialVariantId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    biz = await setupInventoryFixture(app, 'erp-pur-a');
    other = await setupInventoryFixture(app, 'erp-pur-b');
    ownerToken = biz.accessToken;

    buyerToken = await userOnTemplate('INVENTORY_MANAGER', 'buyer');
    approverToken = await userOnTemplate('BRANCH_MANAGER', 'approver');
    payerToken = await userOnTemplate('ACCOUNTANT', 'payer');
    noCostToken = await userOnCustomRole('PROCUREMENT', 'proc', [
      'suppliers.view', 'suppliers.create', 'purchases.view', 'purchases.create',
      'purchases.approve', 'purchases.receive', 'purchases.return', 'purchases.pay',
      'products.view', 'warehouses.view', 'inventory.view',
    ]);
    viewerToken = await userOnCustomRole('PURCHVIEWER', 'pview', ['suppliers.view', 'purchases.view', 'products.view']);

    ({ variantId } = await createSimpleProduct(app, ownerToken, biz.uomId, 'PUR-A', {
      defaultCost: 100,
      defaultSellingPrice: 300,
    }));
    ({ variantId: serialVariantId } = await createSimpleProduct(app, ownerToken, biz.uomId, 'PUR-SER', {
      tracksSerialNumbers: true,
      defaultCost: 200,
      defaultSellingPrice: 500,
    }));

    const supplier = await request(app.getHttpServer())
      .post('/api/v1/purchasing/suppliers')
      .set('Authorization', bearer(ownerToken))
      .send({ name: 'Acme Supplies', contactPerson: 'Sam', paymentTermsDays: 30 })
      .expect(201);
    supplierId = supplier.body.data.id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const bearer = (t: string) => `Bearer ${t}`;

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'ErpUserPass1!', businessSlug: biz.slug })
      .expect(200);
    return res.body.data.accessToken;
  }
  async function userOnTemplate(template: string, handle: string): Promise<string> {
    const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: template } });
    return createUser(handle, [role.id]);
  }
  async function userOnCustomRole(name: string, handle: string, permissionCodes: string[]): Promise<string> {
    const role = await request(app.getHttpServer())
      .post('/api/v1/roles')
      .set('Authorization', bearer(biz.accessToken))
      .send({ name, permissionCodes })
      .expect(201);
    return createUser(handle, [role.body.data.id]);
  }
  async function createUser(handle: string, roleIds: string[]): Promise<string> {
    const email = `${handle}@${biz.slug}.test`;
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', bearer(biz.accessToken))
      .send({ name: handle, email, password: 'ErpUserPass1!', roleIds })
      .expect(201);
    return login(email);
  }

  /** A fresh APPROVED order, ready to receive. */
  async function approvedOrder(quantity = 10, unitCost = 100, variant = variantId) {
    const created = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', bearer(buyerToken))
      .send({ warehouseId: biz.warehouseId, supplierId, items: [{ variantId: variant, quantityOrdered: quantity, unitCost }] })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${created.body.data.id}/approve`)
      .set('Authorization', bearer(approverToken))
      .send({})
      .expect(200);
    return created.body.data as { id: string; items: { id: string }[] };
  }

  /** Deep search for any key in an object graph. */
  function findKeys(value: unknown, keys: string[], path = ''): string[] {
    const hits: string[] = [];
    const walk = (v: unknown, p: string) => {
      if (v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (keys.includes(k)) hits.push(`${p}.${k}`);
        walk(val, `${p}.${k}`);
      }
    };
    walk(value, path);
    return hits;
  }

  // ================================================================
  // 1. Suppliers
  // ================================================================
  describe('suppliers', () => {
    it('serves the shape the supplier screen renders, with a SERVER-computed balance', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/purchasing/suppliers')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      const row = res.body.data.find((s: { id: string }) => s.id === supplierId);
      expect(row).toEqual(
        expect.objectContaining({ name: 'Acme Supplies', isActive: true, paymentTermsDays: 30, balance: expect.any(String) }),
      );
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ page: 1, total: expect.any(Number), totalPages: expect.any(Number) }),
      );
    });

    it('searches and filters SERVER-side', async () => {
      const found = await request(app.getHttpServer())
        .get('/api/v1/purchasing/suppliers?search=Acme')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(found.body.data.map((s: { id: string }) => s.id)).toContain(supplierId);

      const missing = await request(app.getHttpServer())
        .get('/api/v1/purchasing/suppliers?search=NoSuchSupplier')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(missing.body.data).toEqual([]);

      // `?isActive=false` MEANS false. It did not before this milestone:
      // `z.coerce.boolean()` runs `Boolean("false")`, which is `true`, so
      // every "show me the inactive ones" filter in the product returned
      // the ACTIVE ones. Found by building the supplier screen, fixed in
      // `queryBooleanSchema`.
      const inactive = await request(app.getHttpServer())
        .get('/api/v1/purchasing/suppliers?isActive=false')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(inactive.body.data.map((s: { id: string }) => s.id)).not.toContain(supplierId);
      expect(inactive.body.data.every((s: { isActive: boolean }) => s.isActive === false)).toBe(true);

      const active = await request(app.getHttpServer())
        .get('/api/v1/purchasing/suppliers?isActive=true')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(active.body.data.map((s: { id: string }) => s.id)).toContain(supplierId);
      expect(active.body.data.every((s: { isActive: boolean }) => s.isActive === true)).toBe(true);

      // A value that is neither is refused rather than guessed at.
      await request(app.getHttpServer())
        .get('/api/v1/purchasing/suppliers?isActive=maybe')
        .set('Authorization', bearer(ownerToken))
        .expect(422);
    });

    it('creates and edits, and refuses both without the grant', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/purchasing/suppliers')
        .set('Authorization', bearer(viewerToken))
        .send({ name: 'Nope' })
        .expect(403);

      const created = await request(app.getHttpServer())
        .post('/api/v1/purchasing/suppliers')
        .set('Authorization', bearer(buyerToken))
        .send({ name: 'Second Supplier', email: 'sales@second.test' })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/api/v1/purchasing/suppliers/${created.body.data.id}`)
        .set('Authorization', bearer(viewerToken))
        .send({ name: 'Renamed by a viewer' })
        .expect(403);

      const edited = await request(app.getHttpServer())
        .patch(`/api/v1/purchasing/suppliers/${created.body.data.id}`)
        .set('Authorization', bearer(buyerToken))
        .send({ contactPerson: 'Alex' })
        .expect(200);
      expect(edited.body.data.contactPerson).toBe('Alex');
      // The unedited field survives a partial update.
      expect(edited.body.data.name).toBe('Second Supplier');
    });

    it('DEACTIVATES rather than deletes, and refuses while an order is open', async () => {
      // `suppliers.delete` is a SOFT delete — which is why the ERP's
      // button says "Deactivate".
      const supplier = await request(app.getHttpServer())
        .post('/api/v1/purchasing/suppliers')
        .set('Authorization', bearer(ownerToken))
        .send({ name: 'Temporary Supplier' })
        .expect(201);

      // An INVENTORY_MANAGER may create suppliers but NOT deactivate one.
      await request(app.getHttpServer())
        .delete(`/api/v1/purchasing/suppliers/${supplier.body.data.id}`)
        .set('Authorization', bearer(buyerToken))
        .expect(403);

      const order = await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', bearer(buyerToken))
        .send({
          warehouseId: biz.warehouseId,
          supplierId: supplier.body.data.id,
          items: [{ variantId, quantityOrdered: 1, unitCost: 5 }],
        })
        .expect(201);

      const blocked = await request(app.getHttpServer())
        .delete(`/api/v1/purchasing/suppliers/${supplier.body.data.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(409);
      expect(blocked.body.error.code).toBe('CONFLICT');

      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.body.data.id}/cancel`)
        .set('Authorization', bearer(approverToken))
        .send({ reason: 'not needed' })
        .expect(200);

      const gone = await request(app.getHttpServer())
        .delete(`/api/v1/purchasing/suppliers/${supplier.body.data.id}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(gone.body.data.isActive).toBe(false);

      // Still THERE — nothing was destroyed.
      const still = await admin.supplier.findUniqueOrThrow({ where: { id: supplier.body.data.id } });
      expect(still.name).toBe('Temporary Supplier');
    });

    it('refuses an inactive supplier on a new order', async () => {
      const inactive = await admin.supplier.findFirstOrThrow({
        where: { businessId: biz.businessId, isActive: false },
      });
      await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', bearer(buyerToken))
        .send({ warehouseId: biz.warehouseId, supplierId: inactive.id, items: [{ variantId, quantityOrdered: 1, unitCost: 5 }] })
        .expect(422);
    });
  });

  // ================================================================
  // 2. COST AUDIT — a negative result, verified not assumed
  // ================================================================
  describe('cost audit', () => {
    const PROTECTED = ['defaultCost', 'cost', 'averageCost', 'unitCostAtMovement', 'cogsPerUnit'];

    it('carries NO protected cost on any purchasing READ, for a caller without products.view_cost', async () => {
      // Phase 14 found this defect class in Catalogue, Phase 15 in
      // Inventory. Purchasing is clean, and that is proved rather than
      // inferred: every response projects the variant to `{id, sku}`, so
      // the product's own cost and the warehouse's average cost never
      // appear.
      const order = await approvedOrder();
      for (const path of [
        '/api/v1/purchasing/purchases',
        `/api/v1/purchasing/purchases/${order.id}`,
        '/api/v1/purchasing/suppliers',
        `/api/v1/purchasing/suppliers/${supplierId}`,
      ]) {
        const res = await request(app.getHttpServer()).get(path).set('Authorization', bearer(noCostToken)).expect(200);
        expect(findKeys(res.body, PROTECTED)).toEqual([]);
      }
    });

    it('carries NO protected cost on any purchasing MUTATION either', async () => {
      const order = await approvedOrder(4, 50);
      const responses = [
        await request(app.getHttpServer())
          .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
          .set('Authorization', bearer(noCostToken))
          .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 2 }] })
          .expect(201),
        await request(app.getHttpServer())
          .post(`/api/v1/purchasing/purchases/${order.id}/returns`)
          .set('Authorization', bearer(noCostToken))
          .send({ reason: 'damaged', items: [{ purchaseItemId: order.items[0].id, quantity: 1 }] })
          .expect(201),
        await request(app.getHttpServer())
          .post(`/api/v1/purchasing/purchases/${order.id}/payments`)
          .set('Authorization', bearer(noCostToken))
          .send({ amount: 10, method: 'CASH' })
          .expect(201),
      ];
      for (const res of responses) expect(findKeys(res.body, PROTECTED)).toEqual([]);
    });

    it('DOES carry the document’s own figures, which purchases.view is the gate for', async () => {
      // `unitCost` and `totalAmount` ARE the purchase order — they are
      // what the business agreed to pay. The live matrix has no
      // purchase-cost sub-permission, so `purchases.view` is the gate.
      // Recorded here so the behaviour is explicit rather than incidental.
      const order = await approvedOrder(3, 77);
      const res = await request(app.getHttpServer())
        .get(`/api/v1/purchasing/purchases/${order.id}`)
        .set('Authorization', bearer(noCostToken))
        .expect(200);
      expect(Number(res.body.data.items[0].unitCost)).toBe(77);
      expect(Number(res.body.data.totalAmount)).toBe(231);
    });
  });

  // ================================================================
  // 3. Separation of duties
  // ================================================================
  describe('separation of duties', () => {
    it('an INVENTORY_MANAGER raises and receives but may NOT approve or pay', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', bearer(buyerToken))
        .send({ warehouseId: biz.warehouseId, supplierId, items: [{ variantId, quantityOrdered: 5, unitCost: 20 }] })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${created.body.data.id}/approve`)
        .set('Authorization', bearer(buyerToken))
        .send({})
        .expect(403);

      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${created.body.data.id}/payments`)
        .set('Authorization', bearer(buyerToken))
        .send({ amount: 1, method: 'CASH' })
        .expect(403);
    });

    it('a BRANCH_MANAGER approves and cancels but may NOT raise or receive', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', bearer(approverToken))
        .send({ warehouseId: biz.warehouseId, supplierId, items: [{ variantId, quantityOrdered: 1, unitCost: 1 }] })
        .expect(403);

      const order = await approvedOrder(2, 10);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(approverToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 1 }] })
        .expect(403);
    });

    it('an ACCOUNTANT pays and may NOT raise, approve or receive', async () => {
      const order = await approvedOrder(2, 10);

      await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', bearer(payerToken))
        .send({ warehouseId: biz.warehouseId, supplierId, items: [{ variantId, quantityOrdered: 1, unitCost: 1 }] })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(payerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 1 }] })
        .expect(403);

      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/payments`)
        .set('Authorization', bearer(payerToken))
        .send({ amount: 5, method: 'BANK_TRANSFER' })
        .expect(201);
    });

    it('a refused mutation writes NOTHING', async () => {
      const before = await admin.purchase.count({ where: { businessId: biz.businessId } });
      await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', bearer(viewerToken))
        .send({ warehouseId: biz.warehouseId, supplierId, items: [{ variantId, quantityOrdered: 1, unitCost: 1 }] })
        .expect(403);
      expect(await admin.purchase.count({ where: { businessId: biz.businessId } })).toBe(before);
    });
  });

  // ================================================================
  // 4. Lifecycle
  // ================================================================
  describe('lifecycle', () => {
    it('computes the document totals SERVER-side on create', async () => {
      // The reason the create form shows no running total: this is the
      // only calculator, and it runs in Decimal inside the write.
      const created = await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', bearer(buyerToken))
        .send({
          warehouseId: biz.warehouseId,
          supplierId,
          items: [
            { variantId, quantityOrdered: 3, unitCost: 100, taxAmount: 15, discountAmount: 5 },
            { variantId: serialVariantId, quantityOrdered: 2, unitCost: 200, taxAmount: 40 },
          ],
        })
        .expect(201);

      expect(Number(created.body.data.subtotal)).toBe(700);
      expect(Number(created.body.data.taxAmount)).toBe(55);
      expect(Number(created.body.data.discountAmount)).toBe(5);
      expect(Number(created.body.data.totalAmount)).toBe(750);
      expect(Number(created.body.data.items[0].lineTotal)).toBe(310);
      // `branchId` is derived from the warehouse, never accepted.
      expect(created.body.data.branchId).toBe(biz.branchId);
      expect(created.body.data.status).toBe('DRAFT');
    });

    it('allows editing ONLY a DRAFT', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', bearer(buyerToken))
        .send({ warehouseId: biz.warehouseId, supplierId, items: [{ variantId, quantityOrdered: 1, unitCost: 10 }] })
        .expect(201);

      const edited = await request(app.getHttpServer())
        .patch(`/api/v1/purchasing/purchases/${created.body.data.id}`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ variantId, quantityOrdered: 4, unitCost: 25 }] })
        .expect(200);
      expect(Number(edited.body.data.totalAmount)).toBe(100);

      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${created.body.data.id}/approve`)
        .set('Authorization', bearer(approverToken))
        .send({})
        .expect(200);

      const refused = await request(app.getHttpServer())
        .patch(`/api/v1/purchasing/purchases/${created.body.data.id}`)
        .set('Authorization', bearer(buyerToken))
        .send({ notes: 'too late' })
        .expect(409);
      expect(refused.body.error.code).toBe('CONFLICT');
    });

    it('refuses a second approval and refuses receiving a DRAFT', async () => {
      const order = await approvedOrder(2, 10);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/approve`)
        .set('Authorization', bearer(approverToken))
        .send({})
        .expect(409);

      const draft = await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', bearer(buyerToken))
        .send({ warehouseId: biz.warehouseId, supplierId, items: [{ variantId, quantityOrdered: 1, unitCost: 1 }] })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${draft.body.data.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: draft.body.data.items[0].id, quantityReceived: 1 }] })
        .expect(409);
    });

    it('cancels, and then refuses everything else on a cancelled order', async () => {
      const order = await approvedOrder(2, 10);
      const cancelled = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/cancel`)
        .set('Authorization', bearer(approverToken))
        .send({ reason: 'supplier out of stock' })
        .expect(200);
      expect(cancelled.body.data.status).toBe('CANCELLED');
      expect(cancelled.body.data.cancelReason).toBe('supplier out of stock');

      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/cancel`)
        .set('Authorization', bearer(approverToken))
        .send({})
        .expect(409);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 1 }] })
        .expect(409);
    });
  });

  // ================================================================
  // 5. Receiving: inventory + accounting, exactly once
  // ================================================================
  describe('receiving', () => {
    it('receives PARTIALLY, then fully, moving the status each time', async () => {
      const order = await approvedOrder(10, 100);

      const partial = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 4 }] })
        .expect(201);
      expect(partial.body.data.receiptNumber).toEqual(expect.any(String));

      const midway = await request(app.getHttpServer())
        .get(`/api/v1/purchasing/purchases/${order.id}`)
        .set('Authorization', bearer(buyerToken))
        .expect(200);
      expect(midway.body.data.status).toBe('PARTIALLY_RECEIVED');
      expect(Number(midway.body.data.items[0].quantityReceived)).toBe(4);

      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 6 }] })
        .expect(201);

      const done = await request(app.getHttpServer())
        .get(`/api/v1/purchasing/purchases/${order.id}`)
        .set('Authorization', bearer(buyerToken))
        .expect(200);
      expect(done.body.data.status).toBe('RECEIVED');
      expect(done.body.data.receipts).toHaveLength(2);
    });

    it('refuses OVER-receiving', async () => {
      const order = await approvedOrder(5, 10);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 6 }] })
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('increases stock EXACTLY ONCE and posts ONE BALANCED journal entry', async () => {
      const { variantId: freshVariant } = await createSimpleProduct(app, ownerToken, biz.uomId, 'PUR-ACCT', {
        defaultCost: 40,
        defaultSellingPrice: 90,
      });
      const order = await approvedOrder(8, 40, freshVariant);

      const movementsBefore = await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId: freshVariant } });

      const receipt = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 8 }] })
        .expect(201);

      // Exactly one movement, of the right type and quantity.
      const movements = await admin.stockMovement.findMany({
        where: { businessId: biz.businessId, variantId: freshVariant },
      });
      expect(movements).toHaveLength(movementsBefore + 1);
      expect(movements[0].movementType).toBe('PURCHASE');
      expect(Number(movements[0].quantityBase)).toBe(8);

      const balance = await admin.stockBalance.findFirstOrThrow({
        where: { businessId: biz.businessId, warehouseId: biz.warehouseId, variantId: freshVariant },
      });
      expect(Number(balance.quantityOnHand)).toBe(8);

      // Exactly one journal entry for this receipt, and it balances.
      const entries = await admin.journalEntry.findMany({
        where: { businessId: biz.businessId, sourceType: 'PurchaseReceipt', sourceId: receipt.body.data.id },
        include: { lines: true },
      });
      expect(entries).toHaveLength(1);
      const debit = entries[0].lines.reduce((s, l) => s + Number(l.debit), 0);
      const credit = entries[0].lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(debit).toBeCloseTo(credit, 6);
      expect(debit).toBeCloseTo(320, 6);

      // And the supplier payable moved by the same amount. The ledger row
      // references the RECEIPT, not the order — verified rather than
      // assumed: a purchase can produce several receipts, and each one is
      // its own payable event.
      const ledger = await admin.supplierTransaction.findFirstOrThrow({
        where: { businessId: biz.businessId, supplierId, referenceType: 'PurchaseReceipt', referenceId: receipt.body.data.id },
      });
      expect(ledger.type).toBe('PURCHASE');
      expect(Number(ledger.amount)).toBeCloseTo(320, 6);
    });

    it('REPLAYS an idempotency key instead of receiving twice', async () => {
      // The contract carries `idempotencyKey`, and the ERP generates one
      // per receive dialog — so a double-submitted delivery cannot
      // double the stock.
      const { variantId: idemVariant } = await createSimpleProduct(app, ownerToken, biz.uomId, 'PUR-IDEM', {
        defaultCost: 15,
        defaultSellingPrice: 40,
      });
      const order = await approvedOrder(6, 15, idemVariant);
      const key = `erp-receive-${Date.now()}`;
      const body = { idempotencyKey: key, items: [{ purchaseItemId: order.items[0].id, quantityReceived: 6 }] };

      const first = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send(body)
        .expect(201);
      const replay = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send(body)
        .expect(201);

      // The SAME receipt comes back.
      expect(replay.body.data.id).toBe(first.body.data.id);

      // ...and stock moved once, not twice.
      const balance = await admin.stockBalance.findFirstOrThrow({
        where: { businessId: biz.businessId, warehouseId: biz.warehouseId, variantId: idemVariant },
      });
      expect(Number(balance.quantityOnHand)).toBe(6);
      expect(
        await admin.stockMovement.count({ where: { businessId: biz.businessId, variantId: idemVariant } }),
      ).toBe(1);
      expect(await admin.purchaseReceipt.count({ where: { businessId: biz.businessId, idempotencyKey: key } })).toBe(1);
    });

    it('REJECTS a replayed key that names a DIFFERENT delivery', async () => {
      const order = await approvedOrder(6, 15);
      const key = `erp-mismatch-${Date.now()}`;
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ idempotencyKey: key, items: [{ purchaseItemId: order.items[0].id, quantityReceived: 2 }] })
        .expect(201);

      const mismatched = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ idempotencyKey: key, items: [{ purchaseItemId: order.items[0].id, quantityReceived: 4 }] })
        .expect(409);
      expect(mismatched.body.error.code).toBe('CONFLICT');
    });

    it('rolls back BOTH the movement and the journal when the receive fails', async () => {
      const order = await approvedOrder(3, 10);
      const movementsBefore = await admin.stockMovement.count({ where: { businessId: biz.businessId } });
      const entriesBefore = await admin.journalEntry.count({ where: { businessId: biz.businessId } });
      const receiptsBefore = await admin.purchaseReceipt.count({ where: { businessId: biz.businessId } });

      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 99 }] })
        .expect(409);

      expect(await admin.stockMovement.count({ where: { businessId: biz.businessId } })).toBe(movementsBefore);
      expect(await admin.journalEntry.count({ where: { businessId: biz.businessId } })).toBe(entriesBefore);
      expect(await admin.purchaseReceipt.count({ where: { businessId: biz.businessId } })).toBe(receiptsBefore);
    });

    it('serialises concurrent receives on the SAME order', async () => {
      // `lockPurchase` takes SELECT ... FOR UPDATE on the purchase row, so
      // the second request recomputes what is left from the first's
      // already-applied increment. The browser has no locking of its own.
      const { variantId: raceVariant } = await createSimpleProduct(app, ownerToken, biz.uomId, 'PUR-RACE', {
        defaultCost: 5,
        defaultSellingPrice: 20,
      });
      const order = await approvedOrder(10, 5, raceVariant);

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(app.getHttpServer())
            .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
            .set('Authorization', bearer(buyerToken))
            .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 4 }] }),
        ),
      );
      // 10 ordered, 4 at a time: two succeed (8), the rest are refused.
      const created = results.filter((r) => r.status === 201);
      const refused = results.filter((r) => r.status === 409);
      expect(created.length + refused.length).toBe(4);
      expect(refused.length).toBeGreaterThan(0);

      const balance = await admin.stockBalance.findFirstOrThrow({
        where: { businessId: biz.businessId, warehouseId: biz.warehouseId, variantId: raceVariant },
      });
      // No lost update and no over-receipt: exactly 4 per success.
      expect(Number(balance.quantityOnHand)).toBe(created.length * 4);
      expect(Number(balance.quantityOnHand)).toBeLessThanOrEqual(10);

      const stored = await admin.purchaseItem.findFirstOrThrow({ where: { purchaseId: order.id } });
      expect(Number(stored.quantityReceived)).toBe(Number(balance.quantityOnHand));
    });
  });

  // ================================================================
  // 6. Serials
  // ================================================================
  describe('serials', () => {
    it('REQUIRES serials for a tracked variant and refuses them for an untracked one', async () => {
      const tracked = await approvedOrder(2, 200, serialVariantId);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${tracked.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: tracked.items[0].id, quantityReceived: 2 }] })
        .expect(422);

      const untracked = await approvedOrder(1, 10);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${untracked.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: untracked.items[0].id, quantityReceived: 1, serials: ['NOT-TRACKED-1'] }] })
        .expect(422);
    });

    it('refuses a serial count that disagrees with the quantity', async () => {
      const order = await approvedOrder(2, 200, serialVariantId);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 2, serials: ['ONLY-ONE'] }] })
        .expect(422);
    });

    it('registers the units, owned by the purchase’s warehouse', async () => {
      const order = await approvedOrder(2, 200, serialVariantId);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 2, serials: ['PUR-SN-1', 'PUR-SN-2'] }] })
        .expect(201);

      const serials = await admin.serialNumber.findMany({
        where: { businessId: biz.businessId, serial: { in: ['PUR-SN-1', 'PUR-SN-2'] } },
      });
      expect(serials).toHaveLength(2);
      for (const s of serials) {
        expect(s.status).toBe('IN_STOCK');
        expect(s.currentWarehouseId).toBe(biz.warehouseId);
      }
    });

    it('refuses a DUPLICATE serial', async () => {
      const order = await approvedOrder(1, 200, serialVariantId);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 1, serials: ['PUR-SN-1'] }] })
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('sends a named unit BACK to the supplier and marks it terminal', async () => {
      const order = await approvedOrder(1, 200, serialVariantId);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 1, serials: ['PUR-SN-RET'] }] })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/returns`)
        .set('Authorization', bearer(buyerToken))
        .send({ reason: 'faulty', items: [{ purchaseItemId: order.items[0].id, quantity: 1, serials: ['PUR-SN-RET'] }] })
        .expect(201);

      const unit = await admin.serialNumber.findFirstOrThrow({
        where: { businessId: biz.businessId, serial: 'PUR-SN-RET' },
      });
      // Terminal: the row survives so the serial can never be
      // re-registered as if it were new stock.
      expect(unit.status).toBe('RETURNED_TO_SUPPLIER');
    });
  });

  // ================================================================
  // 7. Returns and payments
  // ================================================================
  describe('returns and payments', () => {
    it('reduces stock and posts a BALANCED entry on a return', async () => {
      const { variantId: retVariant } = await createSimpleProduct(app, ownerToken, biz.uomId, 'PUR-RET', {
        defaultCost: 30,
        defaultSellingPrice: 70,
      });
      const order = await approvedOrder(5, 30, retVariant);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 5 }] })
        .expect(201);

      const ret = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/returns`)
        .set('Authorization', bearer(buyerToken))
        .send({ reason: 'wrong colour', items: [{ purchaseItemId: order.items[0].id, quantity: 2 }] })
        .expect(201);

      const balance = await admin.stockBalance.findFirstOrThrow({
        where: { businessId: biz.businessId, warehouseId: biz.warehouseId, variantId: retVariant },
      });
      expect(Number(balance.quantityOnHand)).toBe(3);

      const entries = await admin.journalEntry.findMany({
        where: { businessId: biz.businessId, sourceType: 'PurchaseReturn', sourceId: ret.body.data.id },
        include: { lines: true },
      });
      expect(entries).toHaveLength(1);
      const debit = entries[0].lines.reduce((s, l) => s + Number(l.debit), 0);
      const credit = entries[0].lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(debit).toBeCloseTo(credit, 6);

      const stored = await admin.purchaseItem.findFirstOrThrow({ where: { purchaseId: order.id } });
      expect(Number(stored.quantityReturned)).toBe(2);
    });

    it('refuses returning more than was received', async () => {
      const order = await approvedOrder(3, 10);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 1 }] })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/returns`)
        .set('Authorization', bearer(buyerToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantity: 2 }] })
        .expect(409);
    });

    it('records a payment, posts a BALANCED entry and moves the supplier balance', async () => {
      const order = await approvedOrder(4, 25);
      const before = await request(app.getHttpServer())
        .get(`/api/v1/purchasing/suppliers/${supplierId}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);

      const payment = await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/payments`)
        .set('Authorization', bearer(payerToken))
        .send({ amount: 60, method: 'BANK_TRANSFER', reference: 'TRX-1' })
        .expect(201);

      const entries = await admin.journalEntry.findMany({
        where: { businessId: biz.businessId, sourceType: 'PurchasePayment', sourceId: payment.body.data.id },
        include: { lines: true },
      });
      expect(entries).toHaveLength(1);
      const debit = entries[0].lines.reduce((s, l) => s + Number(l.debit), 0);
      const credit = entries[0].lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(debit).toBeCloseTo(credit, 6);
      expect(debit).toBeCloseTo(60, 6);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/purchasing/suppliers/${supplierId}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      // The SERVER's ledger sum moved by the payment.
      expect(Number(after.body.data.balance)).toBeCloseTo(Number(before.body.data.balance) - 60, 4);
    });
  });

  // ================================================================
  // 8. Tenant isolation
  // ================================================================
  describe('tenant isolation', () => {
    it('another tenant sees none of these suppliers and cannot mutate them', async () => {
      const list = await request(app.getHttpServer())
        .get('/api/v1/purchasing/suppliers')
        .set('Authorization', bearer(other.accessToken))
        .expect(200);
      expect(list.body.data.map((s: { id: string }) => s.id)).not.toContain(supplierId);

      await request(app.getHttpServer())
        .get(`/api/v1/purchasing/suppliers/${supplierId}`)
        .set('Authorization', bearer(other.accessToken))
        .expect(404);
      await request(app.getHttpServer())
        .patch(`/api/v1/purchasing/suppliers/${supplierId}`)
        .set('Authorization', bearer(other.accessToken))
        .send({ name: 'Stolen' })
        .expect(404);
      await request(app.getHttpServer())
        .delete(`/api/v1/purchasing/suppliers/${supplierId}`)
        .set('Authorization', bearer(other.accessToken))
        .expect(404);

      const still = await admin.supplier.findUniqueOrThrow({ where: { id: supplierId } });
      expect(still.name).toBe('Acme Supplies');
      expect(still.isActive).toBe(true);
    });

    it('a purchase order cannot reference ANOTHER tenant’s supplier or variant', async () => {
      // The cross-tenant reference case specifically.
      await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', bearer(other.accessToken))
        .send({ warehouseId: other.warehouseId, supplierId, items: [{ variantId: 'x', quantityOrdered: 1, unitCost: 1 }] })
        .expect(422);

      const theirSupplier = await request(app.getHttpServer())
        .post('/api/v1/purchasing/suppliers')
        .set('Authorization', bearer(other.accessToken))
        .send({ name: 'Their Supplier' })
        .expect(201);

      // Their own supplier, but OUR variant: refused.
      await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', bearer(other.accessToken))
        .send({
          warehouseId: other.warehouseId,
          supplierId: theirSupplier.body.data.id,
          items: [{ variantId, quantityOrdered: 1, unitCost: 1 }],
        })
        .expect(404);
    });

    it('another tenant sees none of these purchase orders and cannot act on one', async () => {
      const order = await approvedOrder(2, 10);

      const list = await request(app.getHttpServer())
        .get('/api/v1/purchasing/purchases')
        .set('Authorization', bearer(other.accessToken))
        .expect(200);
      expect(list.body.data.map((p: { id: string }) => p.id)).not.toContain(order.id);

      await request(app.getHttpServer())
        .get(`/api/v1/purchasing/purchases/${order.id}`)
        .set('Authorization', bearer(other.accessToken))
        .expect(404);
      for (const action of ['approve', 'cancel']) {
        await request(app.getHttpServer())
          .post(`/api/v1/purchasing/purchases/${order.id}/${action}`)
          .set('Authorization', bearer(other.accessToken))
          .send({})
          .expect(404);
      }
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/receive`)
        .set('Authorization', bearer(other.accessToken))
        .send({ items: [{ purchaseItemId: order.items[0].id, quantityReceived: 1 }] })
        .expect(404);
      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${order.id}/payments`)
        .set('Authorization', bearer(other.accessToken))
        .send({ amount: 1, method: 'CASH' })
        .expect(404);

      // Untouched.
      const stored = await admin.purchase.findUniqueOrThrow({ where: { id: order.id } });
      expect(stored.status).toBe('APPROVED');
    });
  });
});
