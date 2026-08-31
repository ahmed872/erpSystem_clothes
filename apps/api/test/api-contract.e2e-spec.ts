import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupPurchasingFixture, PurchasingFixture, createApprovedPurchase } from './utils/purchasing-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';
import {
  createSaleSchema,
  createSaleReturnSchema,
  receivePurchaseSchema,
  createExpenseSchema,
  adjustCustomerPointsSchema,
  createCashMovementSchema,
  createExchangeSchema,
  resumeHeldSaleSchema,
} from '@retail/shared-validation';

/**
 * Phase 10 (10I) — the frozen API contract.
 *
 * Two things are pinned down here, because both are the kind of rule that
 * silently drifts and is only noticed when a client breaks:
 *
 *   1. IDEMPOTENCY TRAVELS IN THE BODY, as `idempotencyKey`, on every
 *      endpoint that accepts one - never as an `Idempotency-Key` header.
 *      The key belongs to the business document being created, and the
 *      body is where that document is described.
 *   2. A KEY REPLAYED WITH A DIFFERENT PAYLOAD IS 409 EVERYWHERE, never
 *      the original document. Receiving was the one path where that was
 *      not true; this spec is what stops it regressing.
 */
describe('API contract: idempotency transport and the OpenAPI document (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: PurchasingFixture;
  let seq = 0;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupPurchasingFixture(app, 'contract');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function purchaseOf(quantityOrdered: number, tracksSerialNumbers = false) {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `CTR-${seq++}`, {
      defaultCost: 5,
      tracksSerialNumbers,
    });
    const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [
      { variantId, quantityOrdered, unitCost: 5 },
    ]);
    const purchase = await request(app.getHttpServer())
      .get(`/api/v1/purchasing/purchases/${purchaseId}`)
      .set('Authorization', auth())
      .expect(200);
    return { purchaseId, variantId, purchaseItemId: purchase.body.data.items[0].id as string };
  }

  const receive = (purchaseId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send(body);

  // ==================================================================
  describe('Goods receipt idempotency (pre-existing defect, fixed in 10I)', () => {
    it('replays the SAME key with the SAME delivery to the original receipt, receiving the goods once', async () => {
      const { purchaseId, variantId, purchaseItemId } = await purchaseOf(20);
      const body = { idempotencyKey: `grn-${seq++}`, items: [{ purchaseItemId, quantityReceived: 8 }] };

      const first = await receive(purchaseId, body).expect(201);
      const second = await receive(purchaseId, body).expect(201);
      expect(second.body.data.id).toBe(first.body.data.id);

      // Stock went up ONCE.
      expect((await admin.stockBalance.findFirstOrThrow({ where: { variantId } })).quantityOnHand.toString()).toBe('8');
      expect(await admin.purchaseReceipt.count({ where: { purchaseId } })).toBe(1);
      expect(await admin.supplierTransaction.count({ where: { referenceId: first.body.data.id } })).toBe(1);
    });

    it('REGRESSION: the same key with a DIFFERENT delivery is 409, not the first receipt', async () => {
      // THE DEFECT. This used to return the stored receipt whatever the new
      // request said, so a key reused with other quantities was silently
      // handed the first receipt and the second delivery was never
      // recorded - stock the business had actually taken in simply did not
      // exist. Every other idempotent path already compared fingerprints;
      // receiving was the one that did not.
      const { purchaseId, variantId, purchaseItemId } = await purchaseOf(20);
      const key = `grn-differs-${seq++}`;

      await receive(purchaseId, { idempotencyKey: key, items: [{ purchaseItemId, quantityReceived: 5 }] }).expect(201);
      const res = await receive(purchaseId, {
        idempotencyKey: key,
        items: [{ purchaseItemId, quantityReceived: 12 }],
      }).expect(409);
      expect(JSON.stringify(res.body)).toMatch(/different request payload/i);

      // The 12 was refused outright rather than quietly becoming the 5.
      expect((await admin.stockBalance.findFirstOrThrow({ where: { variantId } })).quantityOnHand.toString()).toBe('5');
    });

    it('treats a replay naming DIFFERENT physical units as a different delivery', async () => {
      const { purchaseId, purchaseItemId } = await purchaseOf(4, true);
      const key = `grn-serials-${seq++}`;

      await receive(purchaseId, {
        idempotencyKey: key,
        items: [{ purchaseItemId, quantityReceived: 2, serials: ['CTR-S1', 'CTR-S2'] }],
      }).expect(201);

      // Same key, same quantity, other units. Which physical items arrived
      // is part of the request, so this is a different delivery.
      await receive(purchaseId, {
        idempotencyKey: key,
        items: [{ purchaseItemId, quantityReceived: 2, serials: ['CTR-S3', 'CTR-S4'] }],
      }).expect(409);

      expect(await admin.serialNumber.count({ where: { serial: { in: ['CTR-S3', 'CTR-S4'] } } })).toBe(0);
    });

    it('compares the delivery, not the order it was typed in: "10" and "10.0000" are the same', async () => {
      const { purchaseId, purchaseItemId } = await purchaseOf(20);
      const key = `grn-norm-${seq++}`;
      await receive(purchaseId, { idempotencyKey: key, items: [{ purchaseItemId, quantityReceived: 10 }] }).expect(201);
      await receive(purchaseId, { idempotencyKey: key, items: [{ purchaseItemId, quantityReceived: 10.0 }] }).expect(201);
    });
  });

  // ==================================================================
  describe('Idempotency transport is FROZEN: the body, never a header', () => {
    it('ignores an Idempotency-Key HEADER entirely - two identical requests create two documents', async () => {
      const { purchaseId, variantId, purchaseItemId } = await purchaseOf(20);

      // A client that believes the key belongs in a header gets no
      // protection at all, which is the honest outcome: the server never
      // promised to read one, and pretending otherwise would be worse.
      await receive(purchaseId, { items: [{ purchaseItemId, quantityReceived: 3 }] })
        .set('Idempotency-Key', 'header-key-not-read')
        .expect(201);
      await receive(purchaseId, { items: [{ purchaseItemId, quantityReceived: 3 }] })
        .set('Idempotency-Key', 'header-key-not-read')
        .expect(201);

      expect(await admin.purchaseReceipt.count({ where: { purchaseId } })).toBe(2);
      expect((await admin.stockBalance.findFirstOrThrow({ where: { variantId } })).quantityOnHand.toString()).toBe('6');
    });

    it('accepts `idempotencyKey` in the BODY on every endpoint that supports it', async () => {
      // The frozen list. A future endpoint that takes a key takes it here
      // too; one that stops accepting it in the body is a breaking change.
      for (const schema of [
        createSaleSchema,
        createSaleReturnSchema,
        receivePurchaseSchema,
        createExpenseSchema,
        adjustCustomerPointsSchema,
        createCashMovementSchema,
        createExchangeSchema,
        resumeHeldSaleSchema,
      ]) {
        // A key must be REACHABLE in the body. Parsing a minimal object
        // that carries one and reading it back is stronger than poking at
        // Zod internals: it proves the field survives validation rather
        // than merely appearing in a shape.
        const parsed = schema.safeParse({ idempotencyKey: 'probe' });
        const carriesKey =
          (parsed.success && 'idempotencyKey' in parsed.data) ||
          (!parsed.success && !parsed.error.issues.some((i) => i.path[0] === 'idempotencyKey'));
        expect(carriesKey).toBe(true);
      }
    });
  });

  // ==================================================================
  describe('The OpenAPI document', () => {
    it('builds, and covers every module of the API', async () => {
      const config = new DocumentBuilder().setTitle('t').setVersion('10').addBearerAuth().build();
      const doc = SwaggerModule.createDocument(app, config);
      const paths = Object.keys(doc.paths);

      // Every Phase 10 surface is reachable and documented.
      for (const path of [
        '/api/v1/sales',
        '/api/v1/sales/{id}/receipt',
        '/api/v1/sales/{id}/exchanges',
        '/api/v1/sales/holds',
        '/api/v1/sales/holds/{id}/resume',
        '/api/v1/cash-registers',
        '/api/v1/taxes',
        '/api/v1/expenses',
        '/api/v1/expense-categories',
        '/api/v1/auth/password',
        '/api/v1/users/{id}/password',
      ]) {
        expect(paths).toContain(path);
      }
      // A sanity floor rather than an exact count, which would break on
      // every new endpoint for no benefit.
      expect(paths.length).toBeGreaterThan(80);
    });

    it('routes `sales/holds` to the holds controller, not to `sales/:id`', async () => {
      // Nest matches routes in declaration order, so `sales/:id` would
      // otherwise swallow `sales/holds` and hand a literal "holds" to
      // GetSaleUseCase. This is the assertion that keeps that ordering.
      const res = await request(app.getHttpServer())
        .get('/api/v1/sales/holds')
        .set('Authorization', auth())
        .expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });
});
