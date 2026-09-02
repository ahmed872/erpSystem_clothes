import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupPurchasingFixture, PurchasingFixture } from './utils/purchasing-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 22 (P21-1) — THE ORDER A DOCUMENT'S LINES COME BACK IN.
 *
 * Purchase, receipt and return lines had no defined order, so Postgres
 * returned them in whatever order it found them. The values were always
 * correct; only their sequence was arbitrary — enough to reshuffle a
 * screen under a user who did nothing, and enough to make any
 * position-dependent assertion elsewhere in this suite flake.
 *
 * WHAT THESE CASES PIN. Not a particular sequence — that would just be
 * writing today's accident down. They pin the PROPERTY that matters:
 * repeated reads agree with each other, different endpoints agree with
 * each other, and a line added later sorts after the lines that were
 * there first. `[createdAt, id]` delivers all three over columns that
 * already existed.
 *
 * A note on why `id` is needed at all: a purchase's lines are written by
 * one nested `create` inside a single transaction, and Postgres `now()`
 * is transaction-start time, so every line of one purchase carries an
 * IDENTICAL `createdAt`. Ordering by that column alone would leave the
 * sequence undefined again — which is exactly the bug.
 */
describe('Purchasing: document line order (e2e, real Postgres)', () => {
  let app: INestApplication;
  let biz: PurchasingFixture;
  let variantIds: string[];

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    biz = await setupPurchasingFixture(app, 'line-order');
    variantIds = [];
    // Five lines: enough that an arbitrary order would be very unlikely
    // to match a stable one twice by chance.
    for (let i = 1; i <= 5; i++) {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `ORD-${i}`);
      variantIds.push(variantId);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;
  const api = () => request(app.getHttpServer());
  const idsOf = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);

  async function draft(variants: string[] = variantIds) {
    const res = await api()
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        supplierId: biz.supplierId,
        items: variants.map((variantId) => ({ variantId, quantityOrdered: 10, unitCost: 5 })),
      })
      .expect(201);
    return res.body.data as { id: string; items: { id: string; variantId: string }[] };
  }
  async function get(purchaseId: string) {
    const res = await api().get(`/api/v1/purchasing/purchases/${purchaseId}`).set('Authorization', auth()).expect(200);
    return res.body.data;
  }

  it('returns a purchase’s lines in the SAME order on repeated reads', async () => {
    const created = await draft();
    const reads: string[][] = [];
    for (let i = 0; i < 5; i++) reads.push(idsOf(await get(created.id)));
    for (const read of reads) expect(read).toEqual(reads[0]);
    expect(reads[0]).toHaveLength(5);
  });

  it('agrees between the create response and every later read', async () => {
    const created = await draft();
    expect(idsOf(await get(created.id))).toEqual(idsOf(created));
  });

  it('agrees between the create, approve and get responses', async () => {
    // Three different use-cases build this response independently; they
    // must not disagree about the order of the same five lines.
    const created = await draft();
    const approved = await api()
      .post(`/api/v1/purchasing/purchases/${created.id}/approve`)
      .set('Authorization', auth())
      .send({})
      .expect(200);
    expect(idsOf(approved.body.data)).toEqual(idsOf(created));
    expect(idsOf(await get(created.id))).toEqual(idsOf(created));
  });

  it('puts a line added by a later edit AFTER the lines already there', async () => {
    // The meaningful half of the ordering: an edit is a separate
    // transaction, so its `createdAt` is genuinely later. This is why the
    // sort leads with that column rather than with `id`.
    const created = await draft(variantIds.slice(0, 3));
    const extra = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ORD-LATE');
    const edited = await api()
      .patch(`/api/v1/purchasing/purchases/${created.id}`)
      .set('Authorization', auth())
      .send({
        items: [
          ...variantIds.slice(0, 3).map((variantId) => ({ variantId, quantityOrdered: 10, unitCost: 5 })),
          { variantId: extra.variantId, quantityOrdered: 4, unitCost: 7 },
        ],
      })
      .expect(200);

    const after = await get(created.id);
    expect(after.items).toHaveLength(4);
    expect(idsOf(edited.body.data)).toEqual(idsOf(after));
  });

  it('orders RECEIPT lines deterministically too, including on an idempotent replay', async () => {
    const created = await draft(variantIds.slice(0, 4));
    await api().post(`/api/v1/purchasing/purchases/${created.id}/approve`).set('Authorization', auth()).send({}).expect(200);

    const payload = {
      idempotencyKey: `line-order-${created.id}`,
      items: created.items.map((i) => ({ purchaseItemId: i.id, quantityReceived: 2 })),
    };
    const first = await api()
      .post(`/api/v1/purchasing/purchases/${created.id}/receive`)
      .set('Authorization', auth())
      .send(payload)
      .expect(201);
    // The replay returns the STORED receipt, so its line order has to
    // match what the original response promised.
    const replay = await api()
      .post(`/api/v1/purchasing/purchases/${created.id}/receive`)
      .set('Authorization', auth())
      .send(payload)
      .expect(201);

    expect(idsOf(first.body.data)).toHaveLength(4);
    expect(idsOf(replay.body.data)).toEqual(idsOf(first.body.data));

    const detail = await get(created.id);
    expect(detail.receipts[0].items.map((i: { id: string }) => i.id)).toEqual(idsOf(first.body.data));
  });

  it('orders RETURN lines deterministically too', async () => {
    const created = await draft(variantIds.slice(0, 3));
    await api().post(`/api/v1/purchasing/purchases/${created.id}/approve`).set('Authorization', auth()).send({}).expect(200);
    await api()
      .post(`/api/v1/purchasing/purchases/${created.id}/receive`)
      .set('Authorization', auth())
      .send({ items: created.items.map((i) => ({ purchaseItemId: i.id, quantityReceived: 5 })) })
      .expect(201);

    const returned = await api()
      .post(`/api/v1/purchasing/purchases/${created.id}/returns`)
      .set('Authorization', auth())
      .send({ reason: 'damaged in transit', items: created.items.map((i) => ({ purchaseItemId: i.id, quantity: 1 })) })
      .expect(201);

    expect(idsOf(returned.body.data)).toHaveLength(3);
    const detail = await get(created.id);
    expect(detail.returns[0].items.map((i: { id: string }) => i.id)).toEqual(idsOf(returned.body.data));
  });

  it('changes no value — ordering is presentation only', async () => {
    // The guard against the fix quietly becoming a business change: the
    // same lines, the same quantities, the same money, the same totals.
    const created = await draft(variantIds.slice(0, 3));
    const detail = await get(created.id);
    expect(detail.items.map((i: { variantId: string }) => i.variantId).sort()).toEqual([...variantIds.slice(0, 3)].sort());
    for (const item of detail.items) {
      expect(item.quantityOrdered).toBe('10');
      expect(item.unitCost).toBe('5');
      expect(item.lineTotal).toBe('50');
    }
    expect(detail.subtotal).toBe('150');
    expect(detail.totalAmount).toBe('150');
  });
});
