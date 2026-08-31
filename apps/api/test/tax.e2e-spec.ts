import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture, createTax, setTaxPricingMode } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 10 (BD-18 + the approved resolution of BLOCKING-1) — the Tax Engine.
 *
 * Two claims are under test here, and everything else supports them.
 *
 *   1. A CLIENT CAN NEVER STATE THE TAX IT WOULD LIKE TO PAY. Tax is
 *      resolved and computed inside CreateSaleUseCase's own transaction
 *      from the tenant's stored configuration. The request schema does not
 *      even carry the field any more.
 *
 *   2. TAX-INCLUSIVE PRICING IS AN ENTRY AND DISPLAY CONVENTION ONLY. Every
 *      shelf-denominated amount is converted to net at the LINE BOUNDARY,
 *      after which the pipeline is identical to exclusive mode. That is what
 *      keeps BD-1, BD-2, BD-3, BD-11 and BD-12 operating on the values they
 *      were approved for rather than being quietly reinterpreted - and the
 *      last describe block proves each of those five in inclusive mode.
 *
 * Everything is asserted against real PostgreSQL rows and real journal
 * entries, never against the response body alone.
 */
describe('Tax Engine - BD-18 and BLOCKING-1 (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let customerId: string;

  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'tax');
    customerId = (
      await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', auth())
        .send({ name: 'Tax Customer' })
        .expect(201)
    ).body.data.id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  let seq = 0;

  /** A stocked variant, optionally carrying its own tax or an explicit
   * exemption. 500 units at cost 1, so cost never confuses a total. */
  async function stocked(opts: { taxId?: string; taxExempt?: boolean } = {}) {
    const sku = `TAX-${seq++}`;
    const { productId, variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, sku, {
      defaultCost: 1,
      ...opts,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 500, unitCost: 1 })
      .expect(201);
    return { productId, variantId };
  }

  function sell(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, ...body });
  }

  const saleRow = (id: string) => admin.sale.findUniqueOrThrow({ where: { id }, include: { items: true } });

  async function setDefaultTax(taxId: string | null) {
    await request(app.getHttpServer())
      .put('/api/v1/settings/tax')
      .set('Authorization', auth())
      .send({ defaultTaxId: taxId })
      .expect(200);
  }

  /** The signed net movement on one account within one journal entry. */
  async function entryFor(sourceType: string, sourceId: string) {
    return admin.journalEntry.findFirstOrThrow({
      where: { sourceType, sourceId },
      include: { lines: { include: { account: true } } },
    });
  }
  function netDebitOnCode(
    entry: { lines: { account: { code: string }; debit: Prisma.Decimal; credit: Prisma.Decimal }[] },
    code: string,
  ) {
    return entry.lines
      .filter((l) => l.account.code === code)
      .reduce((sum, l) => sum.plus(l.debit).minus(l.credit), D(0))
      .toString();
  }

  // ==================================================================
  describe('EXCLUSIVE mode - the tax is added on top', () => {
    it('charges the configured rate on the net line value and snapshots the rate that produced it', async () => {
      const taxId = await createTax(app, biz.accessToken, 20);
      const { variantId } = await stocked({ taxId });

      const res = await sell({ items: [{ variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 120 }] }).expect(201);
      const sale = await saleRow(res.body.data.id);

      expect(sale.subtotal.toString()).toBe('100');
      expect(sale.taxAmount.toString()).toBe('20');
      expect(sale.totalAmount.toString()).toBe('120');

      // The line records WHICH tax and WHAT rate produced its figure. The
      // snapshot is what makes a rate editable at all (BD-18 rule 4).
      expect(sale.items[0].taxId).toBe(taxId);
      expect(sale.items[0].taxRateSnapshot!.toString()).toBe('20');
      expect(sale.items[0].taxExempt).toBe(false);
      expect(sale.items[0].taxAmount.toString()).toBe('20');
      // lineTotal has always included tax; that stays true.
      expect(sale.items[0].lineTotal.toString()).toBe('120');

      // The GL sees the same split the sale does.
      const entry = await entryFor('Sale', sale.id);
      expect(netDebitOnCode(entry, '4100')).toBe('-100'); // Revenue credited net
      expect(netDebitOnCode(entry, '2200')).toBe('-20'); //  Tax payable credited
      expect(netDebitOnCode(entry, '1010')).toBe('120'); //  Cash debited gross
    });

    it('taxes the DISCOUNTED net, not the gross - the customer is taxed on what they actually pay', async () => {
      const taxId = await createTax(app, biz.accessToken, 10);
      const { variantId } = await stocked({ taxId });

      // gross 200, manual discount 50 => net 150, tax 15, total 165.
      const res = await sell({
        items: [{ variantId, quantity: 2, unitPrice: 100, discountAmount: 50 }],
        payments: [{ amount: 165 }],
      }).expect(201);
      const sale = await saleRow(res.body.data.id);
      expect(sale.subtotal.toString()).toBe('200');
      expect(sale.discountAmount.toString()).toBe('50');
      expect(sale.taxAmount.toString()).toBe('15'); // 10% of 150, NOT of 200
      expect(sale.totalAmount.toString()).toBe('165');
    });
  });

  // ==================================================================
  describe('INCLUSIVE mode - the same money, entered in shelf terms', () => {
    afterEach(async () => {
      await setTaxPricingMode(app, biz.accessToken, 'EXCLUSIVE');
    });

    it('PARITY: a shelf price of 120 at 20% produces byte-identical stored values to an exclusive 100 + 20', async () => {
      const taxId = await createTax(app, biz.accessToken, 20);
      const { variantId } = await stocked({ taxId });
      await setTaxPricingMode(app, biz.accessToken, 'INCLUSIVE');

      const res = await sell({ items: [{ variantId, quantity: 1, unitPrice: 120 }], payments: [{ amount: 120 }] }).expect(201);
      const sale = await saleRow(res.body.data.id);

      // The SHELF price was 120. What is STORED is the net - the pipeline
      // works in tax-exclusive values in both modes, which is precisely
      // what stops a second set of monetary rules existing.
      expect(sale.items[0].unitPrice.toString()).toBe('100');
      expect(sale.subtotal.toString()).toBe('100');
      expect(sale.taxAmount.toString()).toBe('20');
      expect(sale.totalAmount.toString()).toBe('120');

      const entry = await entryFor('Sale', sale.id);
      expect(netDebitOnCode(entry, '4100')).toBe('-100');
      expect(netDebitOnCode(entry, '2200')).toBe('-20');
      expect(netDebitOnCode(entry, '1010')).toBe('120');
    });

    it('converts the MANUAL DISCOUNT by the same divisor, so "12 off" takes exactly 12 off the shelf price', async () => {
      const taxId = await createTax(app, biz.accessToken, 20);
      const { variantId } = await stocked({ taxId });
      await setTaxPricingMode(app, biz.accessToken, 'INCLUSIVE');

      // Shelf 120, cashier types "12 off". Net price 100, net discount 10,
      // net after discount 90, tax 18 => total 108 = 120 - 12 EXACTLY.
      //
      // Leaving the discount unconverted would net 120/1.2 - 12 = 88, tax
      // 17.60, total 105.60 - i.e. 14.40 off the shelf price when the
      // cashier asked for 12. That is the defect this conversion exists to
      // prevent, and the assertion below is what makes it impossible.
      const res = await sell({
        items: [{ variantId, quantity: 1, unitPrice: 120, discountAmount: 12 }],
        payments: [{ amount: 108 }],
      }).expect(201);
      const sale = await saleRow(res.body.data.id);
      expect(sale.subtotal.toString()).toBe('100');
      expect(sale.discountAmount.toString()).toBe('10');
      expect(sale.taxAmount.toString()).toBe('18');
      expect(sale.totalAmount.toString()).toBe('108');
    });

    it('is the identity for an exempt line - the divisor is exactly 1, with no special case', async () => {
      const { variantId } = await stocked({ taxExempt: true });
      await setTaxPricingMode(app, biz.accessToken, 'INCLUSIVE');

      const res = await sell({ items: [{ variantId, quantity: 1, unitPrice: 120 }], payments: [{ amount: 120 }] }).expect(201);
      const sale = await saleRow(res.body.data.id);
      expect(sale.items[0].unitPrice.toString()).toBe('120');
      expect(sale.taxAmount.toString()).toBe('0');
      expect(sale.totalAmount.toString()).toBe('120');
    });
  });

  // ==================================================================
  describe('Resolution precedence (BD-18 rule 8)', () => {
    it('resolves in order: line exemption > product exemption > product tax > business default > no tax', async () => {
      const defaultTax = await createTax(app, biz.accessToken, 5);
      const productTax = await createTax(app, biz.accessToken, 9);
      await setDefaultTax(defaultTax);

      const plain = await stocked(); //                 falls through to the default
      const own = await stocked({ taxId: productTax }); // its own tax wins
      const exemptProduct = await stocked({ taxExempt: true }); // exemption wins

      // 1. business default applies to a product with no tax of its own
      let sale = await saleRow(
        (await sell({ items: [{ variantId: plain.variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 105 }] }).expect(201)).body.data.id,
      );
      expect(sale.taxAmount.toString()).toBe('5');
      expect(sale.items[0].taxId).toBe(defaultTax);

      // 2. the product's own tax outranks the business default
      sale = await saleRow(
        (await sell({ items: [{ variantId: own.variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 109 }] }).expect(201)).body.data.id,
      );
      expect(sale.taxAmount.toString()).toBe('9');
      expect(sale.items[0].taxId).toBe(productTax);

      // 3. an explicit product exemption outranks both
      sale = await saleRow(
        (await sell({ items: [{ variantId: exemptProduct.variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 100 }] }).expect(201)).body.data.id,
      );
      expect(sale.taxAmount.toString()).toBe('0');
      expect(sale.items[0].taxExempt).toBe(true);
      expect(sale.items[0].taxId).toBeNull();

      // 4. an explicit LINE exemption outranks even the product's own tax
      sale = await saleRow(
        (await sell({ items: [{ variantId: own.variantId, quantity: 1, unitPrice: 100, taxExempt: true }], payments: [{ amount: 100 }] }).expect(201)).body.data.id,
      );
      expect(sale.taxAmount.toString()).toBe('0');
      expect(sale.items[0].taxExempt).toBe(true);
      expect(sale.items[0].taxId).toBeNull();

      // 5. with no default configured at all, an unconfigured product is
      //    UNTAXED - which is recorded differently from EXEMPT. The
      //    distinction is the whole point of rule 8: "no tax applies" and
      //    "this is exempt" are different facts about the world.
      await setDefaultTax(null);
      const untaxed = await stocked();
      sale = await saleRow(
        (await sell({ items: [{ variantId: untaxed.variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 100 }] }).expect(201)).body.data.id,
      );
      expect(sale.taxAmount.toString()).toBe('0');
      expect(sale.items[0].taxId).toBeNull();
      expect(sale.items[0].taxExempt).toBe(false); // untaxed, NOT exempt
    });
  });

  // ==================================================================
  describe('The client cannot state its own tax (BD-18 rule 5)', () => {
    it('IGNORES a caller-supplied taxAmount entirely - the schema does not carry the field', async () => {
      const taxId = await createTax(app, biz.accessToken, 10);
      const { variantId } = await stocked({ taxId });

      const res = await sell({
        // A hostile or simply outdated client asking to pay 999 of tax, and
        // a second one asking to pay none at all.
        items: [{ variantId, quantity: 1, unitPrice: 100, taxAmount: 999 }],
        taxAmount: 0,
        payments: [{ amount: 110 }],
      }).expect(201);

      const sale = await saleRow(res.body.data.id);
      expect(sale.taxAmount.toString()).toBe('10'); // the server's figure, not the client's
      expect(sale.totalAmount.toString()).toBe('110');
    });

    it('leaves the tax the client did not expect OWED, never silently written off', async () => {
      const taxId = await createTax(app, biz.accessToken, 10);
      const { variantId } = await stocked({ taxId });

      // A client that believes the total is 100 tenders 100. The server
      // knows the sale costs 110, and the 10 it did not expect becomes a
      // real receivable on the customer's account rather than a discount
      // the client talked the server into.
      const res = await sell({
        customerId,
        items: [{ variantId, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);
      const sale = await saleRow(res.body.data.id);
      expect(sale.totalAmount.toString()).toBe('110');

      const view = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Authorization', auth())
        .expect(200);
      expect(view.body.data.paidAmount).toBe('100');
      expect(view.body.data.remainingAmount).toBe('10');
      expect(view.body.data.paymentStatus).toBe('PARTIALLY_PAID');

      // And a WALK-IN cannot even do this: with no ledger to carry the
      // remainder, the sale is refused outright.
      const walkIn = await stocked({ taxId });
      await sell({ items: [{ variantId: walkIn.variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 100 }] }).expect(422);
    });
  });

  // ==================================================================
  describe('Historical integrity - a rate change can never reach a past sale', () => {
    it('leaves an existing sale untouched when the rate changes, and applies the new rate only to new sales', async () => {
      const taxId = await createTax(app, biz.accessToken, 10);
      const { variantId } = await stocked({ taxId });

      const before = await saleRow(
        (await sell({ items: [{ variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 110 }] }).expect(201)).body.data.id,
      );
      expect(before.taxAmount.toString()).toBe('10');

      await request(app.getHttpServer())
        .patch(`/api/v1/taxes/${taxId}`)
        .set('Authorization', auth())
        .send({ ratePercent: 25 })
        .expect(200);

      // The historical sale is re-read from the database AFTER the change.
      // Non-negotiable #8: historical sales are never recomputed from
      // current configuration.
      const reread = await saleRow(before.id);
      expect(reread.taxAmount.toString()).toBe('10');
      expect(reread.totalAmount.toString()).toBe('110');
      expect(reread.items[0].taxRateSnapshot!.toString()).toBe('10');

      // ...and the GL entry it posted is equally untouched.
      const entry = await entryFor('Sale', before.id);
      expect(netDebitOnCode(entry, '2200')).toBe('-10');

      // A NEW sale gets the new rate.
      const after = await saleRow(
        (await sell({ items: [{ variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 125 }] }).expect(201)).body.data.id,
      );
      expect(after.taxAmount.toString()).toBe('25');
      expect(after.items[0].taxRateSnapshot!.toString()).toBe('25');
    });

    it('keeps a sold line resolvable after its tax is retired - deactivation stops future charging, nothing more', async () => {
      const taxId = await createTax(app, biz.accessToken, 15);
      const { variantId } = await stocked({ taxId });

      const sold = await saleRow(
        (await sell({ items: [{ variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 115 }] }).expect(201)).body.data.id,
      );
      expect(sold.taxAmount.toString()).toBe('15');

      await request(app.getHttpServer())
        .patch(`/api/v1/taxes/${taxId}`)
        .set('Authorization', auth())
        .send({ isActive: false })
        .expect(200);

      // The historical line still points at the tax and still carries its
      // rate - the row was retired, never deleted, and the grant withholds
      // DELETE to keep that structural.
      const reread = await saleRow(sold.id);
      expect(reread.items[0].taxId).toBe(taxId);
      expect(reread.items[0].taxRateSnapshot!.toString()).toBe('15');

      // A new sale of the same product charges nothing: an inactive tax
      // resolves to no tax rather than raising, because failing every sale
      // until someone reassigns every product would make deactivation
      // unusable in a real shop.
      const next = await saleRow(
        (await sell({ items: [{ variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 100 }] }).expect(201)).body.data.id,
      );
      expect(next.taxAmount.toString()).toBe('0');
      expect(next.items[0].taxId).toBeNull();
    });

    it('refuses to make an inactive tax the business default', async () => {
      const taxId = await createTax(app, biz.accessToken, 7);
      await request(app.getHttpServer())
        .patch(`/api/v1/taxes/${taxId}`)
        .set('Authorization', auth())
        .send({ isActive: false })
        .expect(200);

      await request(app.getHttpServer())
        .put('/api/v1/settings/tax')
        .set('Authorization', auth())
        .send({ defaultTaxId: taxId })
        .expect(422);
    });

    it('never hard-deletes a tax: the database grant withholds DELETE from the application role', async () => {
      const rows: Array<{ privilege_type: string }> = await admin.$queryRawUnsafe(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'erp_app' AND table_name = 'taxes'`,
      );
      const privileges = rows.map((r) => r.privilege_type).sort();
      expect(privileges).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    });
  });

  // ==================================================================
  describe('Tax reversal on returns uses BD-1 cumulative arithmetic', () => {
    it('TELESCOPES EXACTLY: three partial returns of a line reverse precisely the tax it was charged', async () => {
      const taxId = await createTax(app, biz.accessToken, 10);
      const { variantId } = await stocked({ taxId });

      // The rounding trap, in the tax column. 3 units at 33.3333 is 99.9999
      // net, and 10% of that rounds to a line tax of exactly 10 over 3
      // units. A naive per-return proportion is 10/3 = 3.3333 at 4dp, and
      // three of those total 9.9999 - a permanent 0.0001 of tax the business
      // collected and never gave back. BD-1's cumulative method takes the
      // DELTA between successive cumulative figures instead (3.3333 /
      // 3.3334 / 3.3333), summing to exactly 10, which is what the final
      // assertion here pins down.
      const sale = await saleRow(
        (
          await sell({
            customerId,
            items: [{ variantId, quantity: 3, unitPrice: 33.3333 }],
            payments: [],
          }).expect(201)
        ).body.data.id,
      );
      const lineTax = sale.taxAmount;
      expect(lineTax.toString()).toBe('10'); // round4(10% of 99.9999)

      let reversed = D(0);
      for (let i = 0; i < 3; i++) {
        const ret = await request(app.getHttpServer())
          .post(`/api/v1/sales/${sale.id}/returns`)
          .set('Authorization', auth())
          .send({ items: [{ saleItemId: sale.items[0].id, quantity: 1, condition: 'SELLABLE' }] })
          .expect(201);
        const entry = await entryFor('SaleReturn', ret.body.data.id);
        reversed = reversed.plus(netDebitOnCode(entry, '2200')); // tax payable DEBITED back
      }

      // Exactly the tax that was charged - never a fraction more or less.
      expect(reversed.toString()).toBe(lineTax.toString());
    });

    it('reverses nothing on an exempt line, and the entry still balances', async () => {
      const { variantId } = await stocked({ taxExempt: true });
      const sale = await saleRow(
        (await sell({ customerId, items: [{ variantId, quantity: 2, unitPrice: 50 }], payments: [] }).expect(201)).body.data.id,
      );
      const ret = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/returns`)
        .set('Authorization', auth())
        .send({ items: [{ saleItemId: sale.items[0].id, quantity: 2, condition: 'SELLABLE' }] })
        .expect(201);

      const entry = await entryFor('SaleReturn', ret.body.data.id);
      expect(netDebitOnCode(entry, '2200')).toBe('0');
      const debit = entry.lines.reduce((s, l) => s.plus(l.debit), D(0));
      const credit = entry.lines.reduce((s, l) => s.plus(l.credit), D(0));
      expect(debit.toString()).toBe(credit.toString());
    });
  });

  // ==================================================================
  // The five approved decisions BLOCKING-1's resolution promised would
  // survive inclusive pricing untouched. Each is re-proved HERE, in
  // INCLUSIVE mode, against the same rule it was approved under.
  // ==================================================================
  describe('The five approved decisions still hold in INCLUSIVE mode', () => {
    let taxId: string;

    beforeAll(async () => {
      taxId = await createTax(app, biz.accessToken, 20);
      await setTaxPricingMode(app, biz.accessToken, 'INCLUSIVE');
    });

    afterAll(async () => {
      await setTaxPricingMode(app, biz.accessToken, 'EXCLUSIVE');
    });

    it('BD-12: the manual discount is capped at the line gross - measured in NET terms, after conversion', async () => {
      const { variantId } = await stocked({ taxId });
      // Shelf 120, cashier types "500 off". Net gross is 100 and the net
      // discount would be 416.6667, so the cap bites at 100. Merchandise
      // value is zero, never negative - and with a net of zero there is no
      // tax either.
      const sale = await saleRow(
        (await sell({ items: [{ variantId, quantity: 1, unitPrice: 120, discountAmount: 500 }], payments: [] }).expect(201)).body.data.id,
      );
      expect(sale.subtotal.toString()).toBe('100');
      expect(sale.discountAmount.toString()).toBe('100');
      expect(sale.taxAmount.toString()).toBe('0');
      expect(sale.totalAmount.toString()).toBe('0');
      expect(sale.subtotal.minus(sale.discountAmount).isNegative()).toBe(false);
    });

    it('BD-11: a promotion is still capped at the line gross, and the cap is applied to NET values', async () => {
      const { variantId, productId } = await stocked({ taxId });
      await request(app.getHttpServer())
        .post('/api/v1/promotions')
        .set('Authorization', auth())
        .send({
          name: 'Inclusive 200 off',
          type: 'FIXED_AMOUNT',
          fixedAmount: 200,
          targetType: 'PRODUCT',
          targetId: productId,
          validFrom: '2020-01-01',
          validTo: '2099-12-31',
        })
        .expect(201);

      // Net gross is 100; a 200-per-unit promotion cannot take more than
      // that. The promotion's own amount is NOT shelf-converted - it is a
      // stored rule, not something a cashier typed in shelf terms - so the
      // cap is what keeps the line at zero rather than negative.
      const sale = await saleRow(
        (await sell({ items: [{ variantId, quantity: 1, unitPrice: 120 }], payments: [] }).expect(201)).body.data.id,
      );
      expect(sale.subtotal.toString()).toBe('100');
      expect(sale.discountAmount.toString()).toBe('100');
      expect(sale.totalAmount.toString()).toBe('0');
    });

    it('BD-3: the loyalty basis is the NET merchandise value - after discounts and BEFORE tax', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.points_per_currency_unit', value: 1 })
        .expect(200);

      const { variantId } = await stocked({ taxId });
      // Shelf 120 => net 100, tax 20, total 120. The basis is 100: the
      // sentence "net of discounts, before tax" stays LITERALLY true in
      // inclusive mode, which is exactly what the boundary conversion buys.
      const sale = await saleRow(
        (await sell({ customerId, items: [{ variantId, quantity: 1, unitPrice: 120 }], payments: [{ amount: 120 }] }).expect(201)).body.data.id,
      );
      const earn = await admin.customerPoints.findFirstOrThrow({
        where: { customerId, type: 'EARN', referenceId: sale.id },
      });
      expect(earn.basisAmount!.toString()).toBe('100');
      expect(earn.points.toString()).toBe('100');

      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.points_per_currency_unit', value: null })
        .expect(200);
    });

    it('BD-2: a redemption is allocated across lines in NET terms and taxes the reduced value', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.currency_per_point', value: 1 })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${customerId}/points/adjust`)
        .set('Authorization', auth())
        .send({ points: 50, reason: 'BD-2 inclusive test', idempotencyKey: 'tax-bd2-seed' })
        .expect(201);

      const { variantId } = await stocked({ taxId });
      // Shelf 120 => net 100. 50 points = 50 of value, so net after
      // redemption is 50 and the tax follows it down to 10: total 60.
      const sale = await saleRow(
        (
          await sell({
            customerId,
            items: [{ variantId, quantity: 1, unitPrice: 120 }],
            redeemPoints: 50,
            payments: [{ amount: 60 }],
          }).expect(201)
        ).body.data.id,
      );
      expect(sale.subtotal.toString()).toBe('100');
      expect(sale.discountAmount.toString()).toBe('50');
      expect(sale.taxAmount.toString()).toBe('10');
      expect(sale.totalAmount.toString()).toBe('60');

      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.currency_per_point', value: null })
        .expect(200);
    });

    it('BD-1: a return credits the historical NET effective value, never the shelf price', async () => {
      const { variantId } = await stocked({ taxId });
      // Shelf 120 x 3 = net 300, shelf discount 60 => net discount 50, so
      // net merchandise is 250 and tax is 50: total 300 (= 360 shelf - 60).
      const sale = await saleRow(
        (
          await sell({
            customerId,
            items: [{ variantId, quantity: 3, unitPrice: 120, discountAmount: 60 }],
            payments: [],
          }).expect(201)
        ).body.data.id,
      );
      expect(sale.subtotal.toString()).toBe('300');
      expect(sale.discountAmount.toString()).toBe('50');
      expect(sale.taxAmount.toString()).toBe('50');
      expect(sale.totalAmount.toString()).toBe('300');

      const ret = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/returns`)
        .set('Authorization', auth())
        .send({ items: [{ saleItemId: sale.items[0].id, quantity: 3, condition: 'SELLABLE' }] })
        .expect(201);

      const entry = await entryFor('SaleReturn', ret.body.data.id);
      // Revenue reversed by the NET merchandise value of 250 - not the 300
      // net gross, and emphatically not the 360 shelf gross.
      expect(netDebitOnCode(entry, '4100')).toBe('250');
      expect(netDebitOnCode(entry, '2200')).toBe('50');

      const credit = await admin.customerTransaction.findFirstOrThrow({
        where: { referenceType: 'SaleReturn', referenceId: ret.body.data.id, type: 'SALE_RETURN' },
      });
      // The customer is credited exactly what the sale debited them: 300.
      expect(credit.amount.negated().toString()).toBe('300');
    });
  });

  // ==================================================================
  describe('Security and isolation', () => {
    it('hides tax configuration from a role without tax.view, and editing from a role without tax.manage', async () => {
      const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'CASHIER' } });
      const email = `taxcashier@${biz.slug}.test`;
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'taxcashier', email, password: 'RoleUserPass1!', roleIds: [role.id], branchIds: [] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'RoleUserPass1!', businessSlug: biz.slug })
        .expect(200);
      const cashierAuth = `Bearer ${login.body.data.accessToken}`;

      // A cashier sells all day and never sets the rate the shop charges.
      await request(app.getHttpServer()).get('/api/v1/taxes').set('Authorization', cashierAuth).expect(403);
      await request(app.getHttpServer()).post('/api/v1/taxes').set('Authorization', cashierAuth).send({ name: 'Sneaky', ratePercent: 0 }).expect(403);
      await request(app.getHttpServer()).put('/api/v1/settings/tax').set('Authorization', cashierAuth).send({ taxPricingMode: 'INCLUSIVE' }).expect(403);
    });

    it('enforces RLS and FORCE RLS on taxes at the database level', async () => {
      const rows: Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }> = await admin.$queryRawUnsafe(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'taxes'`,
      );
      expect(rows[0].relrowsecurity).toBe(true);
      expect(rows[0].relforcerowsecurity).toBe(true);

      const policies: Array<{ qual: string | null; with_check: string | null }> = await admin.$queryRawUnsafe(
        `SELECT qual, with_check FROM pg_policies WHERE tablename = 'taxes'`,
      );
      expect(policies.length).toBe(1);
      // Both halves present: a tenant can neither read nor write another's.
      expect(policies[0].qual).toContain('current_tenant_id');
      expect(policies[0].with_check).toContain('current_tenant_id');
    });

    it('constrains the rate at the database level, not only in the request schema', async () => {
      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO taxes (id, business_id, name, rate_percent, updated_at)
             VALUES (gen_random_uuid()::text, $1, 'Impossible', 1500, now())`,
          biz.businessId,
        ),
      ).rejects.toThrow(/taxes_rate_percent_range/);
    });
  });
});
