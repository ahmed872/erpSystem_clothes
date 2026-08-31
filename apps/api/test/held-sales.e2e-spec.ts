import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture, createTax } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 10 (approved resolution of BLOCKING-2) — HOLD / RESUME, SOFT.
 *
 * The claims under test, in order of how much damage getting them wrong
 * would do:
 *
 *   1. A PARKED BASKET IS NOT A SALE. It is a separate entity, and it
 *      appears in no revenue figure, no tax liability, and no stock
 *      movement. Storing it as a `Sale` with a HELD status - the shape
 *      Phase 5's schema note once proposed - would have been counted as
 *      revenue from the moment it was parked, because no reporting query
 *      in this codebase filters on `Sale.status`.
 *   2. THE HOLD IS SOFT. The reservation counter is advisory: it never
 *      stops a real customer at the till from buying the goods in front of
 *      them, because the Inventory Engine's stock check reads
 *      `quantityOnHand` alone.
 *   3. RESUMING RE-PRICES. The hold is a draft of a REQUEST, so checkout
 *      runs the whole unchanged pipeline against the configuration in
 *      force AT CHECKOUT. Parking a basket cannot lock in a price, a tax
 *      rate, or an expired promotion.
 *   4. A BASKET CANNOT BE SOLD TWICE.
 */
describe('Held sales: hold and resume (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let seq = 0;

  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'holds');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function stocked(qty = 100, opts: { taxId?: string } = {}) {
    const { productId, variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `HOLD-${seq++}`, {
      defaultCost: 5,
      ...opts,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: qty, unitCost: 5 })
      .expect(201);
    return { productId, variantId };
  }

  const hold = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/sales/holds')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, ...body });

  const resume = (id: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(`/api/v1/sales/holds/${id}/resume`).set('Authorization', auth()).send(body);

  const voidHold = (id: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(`/api/v1/sales/holds/${id}/void`).set('Authorization', auth()).send(body);

  const balance = (variantId: string) =>
    admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId } });

  // ==================================================================
  describe('A parked basket is not a sale', () => {
    it('creates NO sale, NO stock movement, NO journal entry and NO customer ledger row', async () => {
      const { variantId } = await stocked();
      const salesBefore = await admin.sale.count({ where: { businessId: biz.businessId } });
      const entriesBefore = await admin.journalEntry.count({ where: { businessId: biz.businessId } });

      const res = await hold({
        label: 'blue coat lady',
        items: [{ variantId, quantity: 3, unitPrice: 40 }],
      }).expect(201);

      expect(res.body.data.status).toBe('OPEN');
      expect(res.body.data.holdNumber).toMatch(/^HOLD-[A-F0-9]{8}$/);
      expect(res.body.data.label).toBe('blue coat lady');

      // THE ASSERTION THIS WHOLE DESIGN EXISTS FOR: nothing financial
      // happened. A basket stored as a Sale row would have shown up in
      // every one of these counts.
      expect(await admin.sale.count({ where: { businessId: biz.businessId } })).toBe(salesBefore);
      expect(await admin.journalEntry.count({ where: { businessId: biz.businessId } })).toBe(entriesBefore);
      expect(await admin.stockMovement.count({ where: { variantId } })).toBe(1); // the opening stock, nothing else
      expect(await admin.customerTransaction.count({ where: { businessId: biz.businessId } })).toBe(0);

      // The goods are still on the shelf in full.
      expect((await balance(variantId)).quantityOnHand.toString()).toBe('100');
    });

    it('is invisible to the sales report and to revenue', async () => {
      const { variantId } = await stocked();
      await hold({ items: [{ variantId, quantity: 5, unitPrice: 1000 }] }).expect(201);

      const report = await request(app.getHttpServer())
        .get('/api/v1/reports/sales/summary')
        .set('Authorization', auth())
        .query({ from: '2000-01-01', to: '2099-12-31' })
        .expect(200);
      // 5 x 1000 of parked basket must not appear anywhere in the takings.
      expect(JSON.stringify(report.body)).not.toContain('5000');
    });

    it('records the ADVISORY reservation, and the available figure reflects it', async () => {
      const { variantId } = await stocked(100);
      await hold({ items: [{ variantId, quantity: 30, unitPrice: 10 }] }).expect(201);

      const row = await balance(variantId);
      expect(row.quantityOnHand.toString()).toBe('100');
      expect(row.quantityReserved.toString()).toBe('30');

      const balances = await request(app.getHttpServer())
        .get('/api/v1/inventory/balances')
        .set('Authorization', auth())
        .query({ variantId })
        .expect(200);
      const mine = balances.body.data.find((b: { variantId: string }) => b.variantId === variantId);
      expect(mine.availableQuantity).toBe('70');
    });
  });

  // ==================================================================
  describe('The hold is SOFT', () => {
    it('NEVER blocks a real sale of the same goods, even beyond the unreserved quantity', async () => {
      const { variantId } = await stocked(10);
      await hold({ items: [{ variantId, quantity: 10, unitPrice: 20 }] }).expect(201);
      expect((await balance(variantId)).quantityReserved.toString()).toBe('10');

      // Every unit is spoken for by the parked basket. A customer standing
      // at the till with the goods in their hands still buys them - which
      // is exactly what SOFT means, and why hard reservation was a
      // separate, deferred decision.
      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId, quantity: 10, unitPrice: 20 }],
          payments: [{ amount: 200 }],
        })
        .expect(201);

      const row = await balance(variantId);
      expect(row.quantityOnHand.toString()).toBe('0');
      // The reservation still stands: the basket was never picked up, and
      // nothing about the sale changed that fact.
      expect(row.quantityReserved.toString()).toBe('10');
    });

    it('refuses to drive the reservation counter negative, at the DATABASE level', async () => {
      const { variantId } = await stocked();
      await expect(
        admin.$executeRawUnsafe(
          `UPDATE stock_balances SET quantity_reserved = -1 WHERE business_id = $1 AND variant_id = $2`,
          biz.businessId,
          variantId,
        ),
      ).rejects.toThrow(/stock_balances_quantity_reserved_nonneg/);
    });
  });

  // ==================================================================
  describe('Resuming', () => {
    it('creates a real sale through the unchanged pipeline, releases the reservation, and closes the hold', async () => {
      const { variantId } = await stocked(100);
      const held = await hold({ items: [{ variantId, quantity: 4, unitPrice: 25 }] }).expect(201);
      expect((await balance(variantId)).quantityReserved.toString()).toBe('4');

      const res = await resume(held.body.data.id, { payments: [{ amount: 100, method: 'CASH' }] }).expect(200);

      expect(res.body.data.heldSale.status).toBe('RESUMED');
      expect(res.body.data.heldSale.resumedSaleId).toBe(res.body.data.sale.id);
      expect(res.body.data.sale.totalAmount).toBe('100');

      const row = await balance(variantId);
      expect(row.quantityOnHand.toString()).toBe('96');
      // Released: leaving it standing would make the available figure
      // understate the shelf by the very units just sold.
      expect(row.quantityReserved.toString()).toBe('0');

      // A real SALE movement and a real balanced journal entry now exist.
      await admin.stockMovement.findFirstOrThrow({
        where: { variantId, movementType: 'SALE', referenceId: res.body.data.sale.id },
      });
      const entry = await admin.journalEntry.findFirstOrThrow({
        where: { sourceType: 'Sale', sourceId: res.body.data.sale.id },
        include: { lines: true },
      });
      const debit = entry.lines.reduce((s, l) => s.plus(l.debit), D(0));
      const credit = entry.lines.reduce((s, l) => s.plus(l.credit), D(0));
      expect(debit.toString()).toBe(credit.toString());
    });

    it('RE-PRICES at checkout: a tax configured after the basket was parked applies to it', async () => {
      const { variantId, productId } = await stocked(100);
      const held = await hold({ items: [{ variantId, quantity: 1, unitPrice: 100 }] }).expect(201);

      // The rate changes while the basket sits on the counter.
      const taxId = await createTax(app, biz.accessToken, 10);
      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', auth())
        .send({ taxId })
        .expect(200);

      const res = await resume(held.body.data.id, { payments: [{ amount: 110, method: 'CASH' }] }).expect(200);
      // The basket was parked untaxed and checked out taxed. A hold is a
      // draft of a request, not a quote.
      expect(res.body.data.sale.taxAmount).toBe('10');
      expect(res.body.data.sale.totalAmount).toBe('110');
    });

    it('RE-PRICES at checkout: a promotion created after the basket was parked applies to it', async () => {
      const { variantId, productId } = await stocked(100);
      const held = await hold({ items: [{ variantId, quantity: 1, unitPrice: 100 }] }).expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/promotions')
        .set('Authorization', auth())
        .send({
          name: `Hold promo ${seq++}`,
          type: 'PERCENTAGE',
          percentageValue: 25,
          targetType: 'PRODUCT',
          targetId: productId,
          validFrom: '2020-01-01',
          validTo: '2099-12-31',
        })
        .expect(201);

      const res = await resume(held.body.data.id, { payments: [{ amount: 75, method: 'CASH' }] }).expect(200);
      expect(res.body.data.sale.discountAmount).toBe('25');
      expect(res.body.data.sale.totalAmount).toBe('75');
    });

    it('fails the WHOLE resume when the goods have since been sold, leaving the basket open', async () => {
      const { variantId } = await stocked(5);
      const held = await hold({ items: [{ variantId, quantity: 5, unitPrice: 10 }] }).expect(201);

      // Someone else buys the lot in the meantime - which a SOFT hold
      // permits by design.
      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId, quantity: 5, unitPrice: 10 }],
          payments: [{ amount: 50 }],
        })
        .expect(201);

      await resume(held.body.data.id, { payments: [{ amount: 50, method: 'CASH' }] }).expect(409);

      // The hold is untouched and still resumable once stock returns - the
      // whole transaction rolled back, reservation included.
      const row = await admin.heldSale.findUniqueOrThrow({ where: { id: held.body.data.id } });
      expect(row.status).toBe('OPEN');
      expect(row.resumedSaleId).toBeNull();
      expect((await balance(variantId)).quantityReserved.toString()).toBe('5');
    });

    it('cannot be resumed twice, and cannot be voided after being resumed', async () => {
      const { variantId } = await stocked(100);
      const held = await hold({ items: [{ variantId, quantity: 2, unitPrice: 10 }] }).expect(201);

      await resume(held.body.data.id, { payments: [{ amount: 20, method: 'CASH' }] }).expect(200);
      await resume(held.body.data.id, { payments: [{ amount: 20, method: 'CASH' }] }).expect(409);
      await voidHold(held.body.data.id).expect(409);

      // Exactly one sale came out of it.
      expect(await admin.sale.count({ where: { resumedFromHold: { some: { id: held.body.data.id } } } })).toBe(1);
    });

    it('two cashiers resuming the SAME basket: exactly one wins', async () => {
      const { variantId } = await stocked(100);
      const held = await hold({ items: [{ variantId, quantity: 3, unitPrice: 10 }] }).expect(201);

      const results = await Promise.all([
        resume(held.body.data.id, { payments: [{ amount: 30, method: 'CASH' }] }),
        resume(held.body.data.id, { payments: [{ amount: 30, method: 'CASH' }] }),
      ]);
      expect(results.filter((r) => r.status === 200).length).toBe(1);

      // One sale, and the goods left the shelf exactly once.
      expect(await admin.sale.count({ where: { resumedFromHold: { some: { id: held.body.data.id } } } })).toBe(1);
      expect((await balance(variantId)).quantityOnHand.toString()).toBe('97');
      expect((await balance(variantId)).quantityReserved.toString()).toBe('0');
    });
  });

  // ==================================================================
  describe('Editing and abandoning', () => {
    it('replacing the lines releases the OLD reservation before claiming the new one', async () => {
      const { variantId } = await stocked(100);
      const held = await hold({ items: [{ variantId, quantity: 5, unitPrice: 10 }] }).expect(201);
      expect((await balance(variantId)).quantityReserved.toString()).toBe('5');

      await request(app.getHttpServer())
        .patch(`/api/v1/sales/holds/${held.body.data.id}`)
        .set('Authorization', auth())
        .send({ label: 'changed their mind', items: [{ variantId, quantity: 3, unitPrice: 10 }] })
        .expect(200);

      // 3, not 8. Claiming the new lines without releasing the old ones
      // would leave the shelf looking permanently emptier than it is.
      expect((await balance(variantId)).quantityReserved.toString()).toBe('3');

      const row = await admin.heldSale.findUniqueOrThrow({
        where: { id: held.body.data.id },
        include: { items: true },
      });
      expect(row.label).toBe('changed their mind');
      expect(row.items.length).toBe(1);
      expect(row.items[0].quantity.toString()).toBe('3');
    });

    it('voiding releases the reservation and keeps the abandoned basket visible', async () => {
      const { variantId } = await stocked(100);
      const held = await hold({ items: [{ variantId, quantity: 7, unitPrice: 10 }] }).expect(201);

      await voidHold(held.body.data.id, { reason: 'customer left' }).expect(200);

      expect((await balance(variantId)).quantityReserved.toString()).toBe('0');
      const row = await admin.heldSale.findUniqueOrThrow({ where: { id: held.body.data.id } });
      expect(row.status).toBe('VOIDED');
      expect(row.voidReason).toBe('customer left');
      // Never deleted: a basket parked and abandoned is a real thing that
      // happened at that till, and staff should be able to see it.
      expect(row.voidedAt).not.toBeNull();
    });

    it('lists OPEN baskets by default, and the terminal ones only when asked', async () => {
      const { variantId } = await stocked(100);
      const keep = await hold({ label: 'still waiting', items: [{ variantId, quantity: 1, unitPrice: 10 }] }).expect(201);
      const gone = await hold({ label: 'abandoned', items: [{ variantId, quantity: 1, unitPrice: 10 }] }).expect(201);
      await voidHold(gone.body.data.id).expect(200);

      const open = await request(app.getHttpServer())
        .get('/api/v1/sales/holds')
        .set('Authorization', auth())
        .query({ limit: 200 })
        .expect(200);
      const openIds = open.body.data.map((h: { id: string }) => h.id);
      expect(openIds).toContain(keep.body.data.id);
      expect(openIds).not.toContain(gone.body.data.id);

      const voided = await request(app.getHttpServer())
        .get('/api/v1/sales/holds')
        .set('Authorization', auth())
        .query({ status: 'VOIDED', limit: 200 })
        .expect(200);
      expect(voided.body.data.map((h: { id: string }) => h.id)).toContain(gone.body.data.id);
    });
  });

  // ==================================================================
  describe('Refusals and guarantees', () => {
    it('refuses a basket with a duplicate variant or an unknown one', async () => {
      const { variantId } = await stocked();
      await hold({
        items: [
          { variantId, quantity: 1, unitPrice: 10 },
          { variantId, quantity: 2, unitPrice: 10 },
        ],
      }).expect(422);
      await hold({ items: [{ variantId: '00000000-0000-0000-0000-000000000000', quantity: 1, unitPrice: 10 }] }).expect(404);
    });

    it('refuses a zero or negative quantity at the DATABASE level, not only in the schema', async () => {
      const { variantId } = await stocked();
      const held = await hold({ items: [{ variantId, quantity: 1, unitPrice: 10 }] }).expect(201);
      await expect(
        admin.$executeRawUnsafe(`UPDATE held_sale_items SET quantity = 0 WHERE held_sale_id = $1`, held.body.data.id),
      ).rejects.toThrow(/held_sale_items_quantity_positive/);
    });

    it('enforces RLS and FORCE RLS on both tables, with a policy carrying BOTH halves', async () => {
      for (const table of ['held_sales', 'held_sale_items']) {
        const cls: Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }> = await admin.$queryRawUnsafe(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
          table,
        );
        expect({ table, ...cls[0] }).toEqual({ table, relrowsecurity: true, relforcerowsecurity: true });

        const policies: Array<{ qual: string | null; with_check: string | null }> = await admin.$queryRawUnsafe(
          `SELECT qual, with_check FROM pg_policies WHERE tablename = $1`,
          table,
        );
        expect(policies.length).toBe(1);
        expect(policies[0].qual).toContain('current_tenant_id');
        expect(policies[0].with_check).toContain('current_tenant_id');
      }
    });

    it('withholds DELETE on held_sales: an abandoned basket is history, not a mistake to erase', async () => {
      const rows: Array<{ privilege_type: string }> = await admin.$queryRawUnsafe(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'erp_app' AND table_name = 'held_sales'`,
      );
      expect(rows.map((r) => r.privilege_type).sort()).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    });

    it('a terminal hold carries its evidence, enforced by CHECK constraints', async () => {
      const { variantId } = await stocked();
      const held = await hold({ items: [{ variantId, quantity: 1, unitPrice: 10 }] }).expect(201);
      // RESUMED with no sale behind it is not a state the data model allows.
      await expect(
        admin.$executeRawUnsafe(`UPDATE held_sales SET status = 'RESUMED' WHERE id = $1`, held.body.data.id),
      ).rejects.toThrow(/held_sales_resumed_all_or_nothing/);
      await expect(
        admin.$executeRawUnsafe(`UPDATE held_sales SET status = 'VOIDED' WHERE id = $1`, held.body.data.id),
      ).rejects.toThrow(/held_sales_voided_all_or_nothing/);
    });

    it('requires sales.hold - and resuming requires sales.create as well', async () => {
      const role = await request(app.getHttpServer())
        .post('/api/v1/roles')
        .set('Authorization', auth())
        .send({
          name: `Park Only ${seq++}`,
          permissionCodes: ['sales.hold', 'sales.view', 'products.view', 'inventory.view', 'shifts.view'],
        })
        .expect(201);

      const email = `parker${seq}@${biz.slug}.test`;
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'parker', email, password: 'RoleUserPass1!', roleIds: [role.body.data.id], branchIds: [] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'RoleUserPass1!', businessSlug: biz.slug })
        .expect(200);
      const token = `Bearer ${login.body.data.accessToken}`;

      const { variantId } = await stocked();
      const held = await hold({ items: [{ variantId, quantity: 1, unitPrice: 10 }] }).expect(201);

      // Can look at parked baskets...
      await request(app.getHttpServer()).get('/api/v1/sales/holds').set('Authorization', token).expect(200);
      // ...but cannot turn one into a sale.
      await request(app.getHttpServer())
        .post(`/api/v1/sales/holds/${held.body.data.id}/resume`)
        .set('Authorization', token)
        .send({ payments: [{ amount: 10, method: 'CASH' }] })
        .expect(403);
    });
  });
});
