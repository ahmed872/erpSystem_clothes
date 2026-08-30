import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 8F - verification-only suite. These tests prove invariants the
 * per-phase suites did not already cover, rather than duplicating them:
 * a cross-tenant WRITE sweep over every Phase 8 table, trial-balance
 * integrity after the fully integrated flow, calculation determinism
 * under repetition, a consolidated atomicity sweep over every rejection
 * path, and historical immunity to product-price and cost changes.
 *
 * Real PostgreSQL and the restricted `erp_app` role throughout.
 */
describe('Phase 8F verification (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let other: SalesFixture;

  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
  let seq = 0;
  const key = (p: string) => `${p}-${Date.now()}-${seq++}`;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, '8f-a');
    other = await setupSalesFixture(app, '8f-b');
    await setSetting('loyalty.currency_per_point', 0.01);
    await setSetting('loyalty.points_per_currency_unit', 2);
    await setSetting('warranty.default_duration_days', 365);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function setSetting(k: string, value: unknown) {
    await request(app.getHttpServer()).put('/api/v1/settings').set('Authorization', auth()).send({ key: k, value }).expect(200);
  }

  async function customer(name: string) {
    const r = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name }).expect(201);
    return r.body.data.id as string;
  }

  async function grant(customerId: string, points: number) {
    await request(app.getHttpServer())
      .post(`/api/v1/sales/customers/${customerId}/points/adjust`)
      .set('Authorization', auth())
      .send({ points, reason: 'seed', idempotencyKey: key('g') })
      .expect(201);
  }

  async function plain(sku: string, opts: { cost?: number; price?: number; qty?: number } = {}) {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, sku, {
      defaultCost: opts.cost ?? 4,
      defaultSellingPrice: opts.price ?? 100,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: opts.qty ?? 200, unitCost: opts.cost ?? 4 })
      .expect(201);
    return variantId;
  }

  async function serialVariant(sku: string, serials: string[]) {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, sku, {
      tracksSerialNumbers: true,
      defaultCost: 10,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: serials.length, unitCost: 10, serials })
      .expect(201);
    return variantId;
  }

  function sell(body: Record<string, unknown>) {
    return request(app.getHttpServer()).post('/api/v1/sales').set('Authorization', auth()).send({ warehouseId: biz.warehouseId, ...body });
  }

  // ==================================================================
  describe('Cross-tenant WRITE sweep over every Phase 8 table', () => {
    it('WITH CHECK rejects a cross-tenant INSERT into every Phase 8 table', async () => {
      // Build one real row of each kind in tenant A so the foreign keys
      // in the forged inserts point at genuinely existing parents.
      const cust = await customer('Sweep');
      await grant(cust, 1000);
      const variantId = await serialVariant('8F-SWEEP', ['SW-1']);
      await request(app.getHttpServer())
        .post('/api/v1/promotions')
        .set('Authorization', auth())
        .send({ name: 'sweep', type: 'PERCENTAGE', percentageValue: 10, targetType: 'VARIANT', targetId: variantId, validFrom: '2020-01-01', validTo: '2099-12-31' })
        .expect(201);

      const sale = await sell({
        customerId: cust,
        items: [{ variantId, quantity: 1, unitPrice: 100, serials: ['SW-1'] }],
        redeemPoints: 100,
        payments: [{ amount: 89 }],
      }).expect(201);
      const saleItemId = sale.body.data.items[0].id;
      const serial = await admin.serialNumber.findFirstOrThrow({ where: { serial: 'SW-1' } });
      const promotion = await admin.promotion.findFirstOrThrow({ where: { businessId: biz.businessId } });
      const warranty = await request(app.getHttpServer())
        .post('/api/v1/warranties')
        .set('Authorization', auth())
        .send({ saleItemId, serialNumberId: serial.id })
        .expect(201);

      // Every forged row carries tenant A's business_id while the session
      // is set to tenant B - exactly what WITH CHECK must refuse.
      const A = biz.businessId;
      const forged: Array<[string, string]> = [
        ['customer_points', `INSERT INTO customer_points (id,business_id,customer_id,type,points) VALUES (gen_random_uuid(),'${A}','${cust}','ADJUSTMENT',5)`],
        ['promotions', `INSERT INTO promotions (id,business_id,name,type,target_type,target_id,percentage_value,valid_from,valid_to,updated_at) VALUES (gen_random_uuid(),'${A}','x','PERCENTAGE','VARIANT','${variantId}',5,now(),now()+interval '1 day',now())`],
        ['sale_promotion_applications', `INSERT INTO sale_promotion_applications (id,business_id,sale_id,sale_item_id,promotion_id,promotion_type,promotion_name,rule_snapshot,discount_applied) VALUES (gen_random_uuid(),'${A}','${sale.body.data.id}','${saleItemId}','${promotion.id}','PERCENTAGE','x','{}',1)`],
        ['warranties', `INSERT INTO warranties (id,business_id,sale_item_id,serial_number_id,start_date,end_date,duration_days,updated_at) VALUES (gen_random_uuid(),'${A}','${saleItemId}','${serial.id}',now(),now()+interval '1 day',1,now())`],
        ['warranty_claims', `INSERT INTO warranty_claims (id,business_id,warranty_id,description) VALUES (gen_random_uuid(),'${A}','${warranty.body.data.id}','x')`],
        ['sale_item_serials', `INSERT INTO sale_item_serials (id,business_id,sale_id,sale_item_id,serial_number_id) VALUES (gen_random_uuid(),'${A}','${sale.body.data.id}','${saleItemId}','${serial.id}')`],
      ];

      const saleRow = await admin.sale.findUniqueOrThrow({ where: { id: sale.body.data.id } });
      forged.push([
        'sales',
        `INSERT INTO sales (id,business_id,branch_id,warehouse_id,shift_id,sale_number,subtotal,discount_amount,tax_amount,total_amount,updated_at)
         VALUES (gen_random_uuid(),'${A}','${saleRow.branchId}','${saleRow.warehouseId}','${saleRow.shiftId}','FORGED-8F',1,0,0,1,now())`,
      ]);

      const runtime = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
      try {
        for (const [table, sql] of forged) {
          await expect(
            runtime
              .$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${other.businessId}'`);
                return tx.$executeRawUnsafe(sql);
              })
              .catch((e) => {
                throw new Error(`${table}: ${(e as Error).message}`);
              }),
          ).rejects.toThrow(/row-level security|permission denied/i);
        }
      } finally {
        await runtime.$disconnect();
      }

      // Nothing was created by any attempt.
      expect(await admin.sale.count({ where: { saleNumber: 'FORGED-8F' } })).toBe(0);
    });

    it('a cross-tenant INSERT...SELECT inserts nothing, because RLS filters the SOURCE rows too', async () => {
      // Not a WITH CHECK rejection but an equally safe outcome, verified
      // explicitly so the difference is understood rather than assumed:
      // tenant B cannot even SEE tenant A's rows to copy them.
      const runtime = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
      try {
        const affected = await runtime.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${other.businessId}'`);
          return tx.$executeRawUnsafe(
            `INSERT INTO customer_points (id,business_id,customer_id,type,points)
             SELECT gen_random_uuid(), business_id, customer_id, 'ADJUSTMENT', 999
               FROM customer_points WHERE business_id = '${biz.businessId}'`,
          );
        });
        expect(affected).toBe(0);
      } finally {
        await runtime.$disconnect();
      }
      expect(await admin.customerPoints.count({ where: { points: 999 } })).toBe(0);
    });

    it('tenant B reads zero rows from every Phase 8 table belonging to tenant A', async () => {
      const runtime = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
      const tables = [
        'customer_points', 'promotions', 'sale_promotion_applications', 'warranties',
        'warranty_claims', 'sale_item_serials', 'sale_return_item_serials',
        'sales', 'sale_items', 'sale_returns',
      ];
      try {
        for (const t of tables) {
          const rows = await runtime.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${other.businessId}'`);
            return tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM ${t} WHERE business_id = '${biz.businessId}'`);
          });
          expect({ table: t, n: Number(rows[0].n) }).toEqual({ table: t, n: 0 });
        }
        // ...and with NO tenant context at all, every table reads empty.
        for (const t of tables) {
          const rows = await runtime.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM ${t}`);
          expect({ table: t, n: Number(rows[0].n) }).toEqual({ table: t, n: 0 });
        }
      } finally {
        await runtime.$disconnect();
      }
    });
  });

  // ==================================================================
  describe('Trial balance after the fully integrated flow', () => {
    it('stays balanced across promotion + loyalty + serial sale and its return', async () => {
      const cust = await customer('TB');
      await grant(cust, 5000);
      const v = await serialVariant('8F-TB', ['TB-1', 'TB-2']);
      await request(app.getHttpServer())
        .post('/api/v1/promotions')
        .set('Authorization', auth())
        .send({ name: 'tb 20pct', type: 'PERCENTAGE', percentageValue: 20, targetType: 'VARIANT', targetId: v, validFrom: '2020-01-01', validTo: '2099-12-31' })
        .expect(201);

      const sale = await sell({
        customerId: cust,
        items: [{ variantId: v, quantity: 2, unitPrice: 100, discountAmount: 10, serials: ['TB-1', 'TB-2'] }],
        redeemPoints: 5000,
        payments: [{ amount: 100 }],
      }).expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.body.data.id}/returns`)
        .set('Authorization', auth())
        .send({ items: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE', serials: ['TB-1'] }] })
        .expect(201);

      const tb = await request(app.getHttpServer())
        .get('/api/v1/accounting/journal-entries/trial-balance')
        .set('Authorization', auth())
        .expect(200);
      expect(tb.body.data.balanced).toBe(true);

      // Independently: every entry in this tenant balances on its own.
      const rows: Array<{ entry_id: string }> = await admin.$queryRawUnsafe(`
        SELECT je.id AS entry_id
          FROM journal_entries je
          JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
         WHERE je.business_id = '${biz.businessId}'
         GROUP BY je.id
        HAVING sum(jel.debit) <> sum(jel.credit)
      `);
      expect(rows).toEqual([]);
    });
  });

  // ==================================================================
  describe('Determinism: identical input yields identical output', () => {
    it('the same promoted, discounted sale computed three times is identical every time', async () => {
      const v = await plain('8F-DET', { qty: 300 });
      await request(app.getHttpServer())
        .post('/api/v1/promotions')
        .set('Authorization', auth())
        .send({ name: 'det 33pct', type: 'PERCENTAGE', percentageValue: 33.33, targetType: 'VARIANT', targetId: v, validFrom: '2020-01-01', validTo: '2099-12-31' })
        .expect(201);

      const shapes: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await sell({
          items: [{ variantId: v, quantity: 7, unitPrice: 13.37, discountAmount: 5 }],
          payments: [{ amount: 0 }].filter(() => false),
        });
        // Walk-in must be paid in full; compute the exact due amount.
        expect([201, 422]).toContain(r.status);
        if (r.status === 422) {
          const gross = D('13.37').times(7);
          const promoDisc = gross.times('33.33').dividedBy(100).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
          const due = gross.minus(D(5).plus(promoDisc));
          const ok = await sell({
            items: [{ variantId: v, quantity: 7, unitPrice: 13.37, discountAmount: 5 }],
            payments: [{ amount: Number(due.toString()) }],
          }).expect(201);
          const sale = await admin.sale.findUniqueOrThrow({ where: { id: ok.body.data.id }, include: { items: true } });
          shapes.push(`${sale.subtotal}|${sale.discountAmount}|${sale.totalAmount}|${sale.items[0].discountAmount}`);
        }
      }
      expect(shapes).toHaveLength(3);
      expect(new Set(shapes).size).toBe(1);
    });

    it('overlapping promotions resolve to the same winner every time', async () => {
      const v = await plain('8F-OVERLAP', { qty: 300 });
      for (const [name, pct] of [['a 10', 10], ['b 10', 10], ['c 25', 25]] as [string, number][]) {
        await request(app.getHttpServer())
          .post('/api/v1/promotions')
          .set('Authorization', auth())
          .send({ name, type: 'PERCENTAGE', percentageValue: pct, targetType: 'VARIANT', targetId: v, validFrom: '2020-01-01', validTo: '2099-12-31' })
          .expect(201);
      }
      const winners: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await sell({ items: [{ variantId: v, quantity: 1, unitPrice: 100 }], payments: [{ amount: 75 }] }).expect(201);
        const apps = await admin.salePromotionApplication.findMany({ where: { saleId: r.body.data.id } });
        expect(apps).toHaveLength(1);
        winners.push(`${apps[0].promotionName}:${apps[0].discountApplied}`);
      }
      expect(new Set(winners).size).toBe(1);
      expect(winners[0]).toBe('c 25:25');
    });
  });

  // ==================================================================
  describe('Atomicity sweep: every rejection path leaves zero trace', () => {
    async function snapshot() {
      const [sales, items, payments, movements, txns, entries, points, apps, links, warranties] = await Promise.all([
        admin.sale.count({ where: { businessId: biz.businessId } }),
        admin.saleItem.count({ where: { businessId: biz.businessId } }),
        admin.salePayment.count({ where: { businessId: biz.businessId } }),
        admin.stockMovement.count({ where: { businessId: biz.businessId } }),
        admin.customerTransaction.count({ where: { businessId: biz.businessId } }),
        admin.journalEntry.count({ where: { businessId: biz.businessId } }),
        admin.customerPoints.count({ where: { businessId: biz.businessId } }),
        admin.salePromotionApplication.count({ where: { businessId: biz.businessId } }),
        admin.saleItemSerial.count({ where: { businessId: biz.businessId } }),
        admin.warranty.count({ where: { businessId: biz.businessId } }),
      ]);
      return { sales, items, payments, movements, txns, entries, points, apps, links, warranties };
    }

    it('leaves no partial trace for any of the seven rejection paths', async () => {
      const cust = await customer('Atomic');
      await grant(cust, 100);
      const rich = await customer('Atomic Rich');
      await grant(rich, 100000);
      const v = await plain('8F-ATOMIC');
      const sv = await serialVariant('8F-ATOMIC-S', ['AT-1']);
      await setSetting('loyalty.currency_per_point', 0.01);

      const cases: Array<[string, () => Promise<unknown>]> = [
        ['insufficient loyalty balance', () => sell({ customerId: cust, items: [{ variantId: v, quantity: 1, unitPrice: 100 }], redeemPoints: 999999, payments: [{ amount: 1 }] }).expect(409)],
        // 1000 points = 10.00 of value against 1.00 of merchandise.
        ['redemption exceeds merchandise', () => sell({ customerId: rich, items: [{ variantId: v, quantity: 1, unitPrice: 1 }], redeemPoints: 1000, payments: [] }).expect(422)],
        ['redemption on walk-in', () => sell({ items: [{ variantId: v, quantity: 1, unitPrice: 100 }], redeemPoints: 10, payments: [{ amount: 99 }] }).expect(422)],
        ['serial-tracked line without serials', () => sell({ items: [{ variantId: sv, quantity: 1, unitPrice: 100 }], payments: [{ amount: 100 }] }).expect(422)],
        ['serial from another variant', () => sell({ items: [{ variantId: sv, quantity: 1, unitPrice: 100, serials: ['NOPE'] }], payments: [{ amount: 100 }] }).expect(422)],
        ['serials on a non-tracked line', () => sell({ items: [{ variantId: v, quantity: 1, unitPrice: 100, serials: ['X'] }], payments: [{ amount: 100 }] }).expect(422)],
        ['overpayment', () => sell({ items: [{ variantId: v, quantity: 1, unitPrice: 10 }], payments: [{ amount: 999 }] }).expect(422)],
      ];

      for (const [label, run] of cases) {
        const before = await snapshot();
        await run();
        const after = await snapshot();
        expect({ label, ...after }).toEqual({ label, ...before });
      }
    });

    it('a zero-value redemption leaves no trace', async () => {
      const cust = await customer('ZeroVal');
      await grant(cust, 100);
      const v = await plain('8F-ZERO');
      await setSetting('loyalty.currency_per_point', 0.000001);
      const before = await snapshot();
      await sell({ customerId: cust, items: [{ variantId: v, quantity: 1, unitPrice: 100 }], redeemPoints: 1, payments: [{ amount: 100 }] }).expect(422);
      expect(await snapshot()).toEqual(before);
      await setSetting('loyalty.currency_per_point', 0.01);
    });
  });

  // ==================================================================
  describe('Historical immunity to catalogue changes', () => {
    it('changing product price and default cost afterwards changes no historical sale, COGS or return', async () => {
      const cust = await customer('Catalogue');
      const { variantId, productId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, '8F-CATALOG', {
        defaultCost: 4,
        defaultSellingPrice: 100,
      }).then(async (r) => {
        await request(app.getHttpServer())
          .post('/api/v1/inventory/opening-stock')
          .set('Authorization', auth())
          .send({ warehouseId: biz.warehouseId, variantId: r.variantId, quantity: 50, unitCost: 4 })
          .expect(201);
        return r;
      });

      const sale = await sell({
        customerId: cust,
        items: [{ variantId, quantity: 4, unitPrice: 100, discountAmount: 40 }],
        payments: [{ amount: 360 }],
      }).expect(201);

      const before = await admin.sale.findUniqueOrThrow({ where: { id: sale.body.data.id }, include: { items: true } });
      const cogsBefore = await admin.stockMovement.findMany({
        where: { referenceType: 'Sale', referenceId: sale.body.data.id },
        select: { unitCostAtMovement: true, quantityBase: true },
      });

      // Mutate the catalogue hard.
      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', auth())
        .send({ defaultCost: 999, defaultSellingPrice: 999 })
        .expect(200);

      const after = await admin.sale.findUniqueOrThrow({ where: { id: sale.body.data.id }, include: { items: true } });
      expect(after.subtotal.toString()).toBe(before.subtotal.toString());
      expect(after.discountAmount.toString()).toBe(before.discountAmount.toString());
      expect(after.totalAmount.toString()).toBe(before.totalAmount.toString());
      expect(after.items[0].unitPrice.toString()).toBe(before.items[0].unitPrice.toString());

      const cogsAfter = await admin.stockMovement.findMany({
        where: { referenceType: 'Sale', referenceId: sale.body.data.id },
        select: { unitCostAtMovement: true, quantityBase: true },
      });
      expect(cogsAfter.map((m) => m.unitCostAtMovement.toString())).toEqual(cogsBefore.map((m) => m.unitCostAtMovement.toString()));

      // The return still credits the HISTORICAL merchandise value.
      const ret = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.body.data.id}/returns`)
        .set('Authorization', auth())
        .send({ items: [{ saleItemId: sale.body.data.items[0].id, quantity: 4, condition: 'SELLABLE' }] })
        .expect(201);
      const txn = await admin.customerTransaction.findFirstOrThrow({
        where: { referenceType: 'SaleReturn', referenceId: ret.body.data.id, type: 'SALE_RETURN' },
      });
      expect(txn.amount.negated().toString()).toBe('360');
    });
  });
});
