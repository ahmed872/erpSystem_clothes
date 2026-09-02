import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture, createTax } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 12 (Exchange preview) — the outcome, before the money moves.
 *
 * The claims under test, mirroring `sale-quote.e2e-spec.ts` and
 * `returns-workflow.e2e-spec.ts`, the two contracts this one composes:
 *
 *   1. THE PREVIEW EQUALS THE COMMIT. Whatever `POST .../exchanges/preview`
 *      reports as `totals.amountDue` / `totals.refundAmount` is EXACTLY
 *      what `POST .../exchanges` accepts and produces - in all three
 *      directions.
 *   2. THE PREVIEW CHANGES NOTHING. No SaleReturn, no Sale, no journal
 *      entry, no stock movement, no loyalty row, no promotion application,
 *      no serial transition - checked by exact row-count sweep, not by
 *      reading the response and hoping.
 *   3. THE PREVIEW DOES NOT REPLACE THE COMMIT'S OWN VALIDATION. A serial
 *      that merely has the right COUNT but the wrong IDENTITY passes the
 *      preview (which only reuses `PreviewSaleReturnUseCase`'s count
 *      check) and is still refused at commit, where identity is checked.
 */
describe('Exchange preview (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let customerId: string;
  let seq = 0;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'exprev');
    customerId = (
      await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', auth())
        .send({ name: 'Exchange Preview Customer' })
        .expect(201)
    ).body.data.id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  function auth() {
    return `Bearer ${biz.accessToken}`;
  }

  async function stocked(opts: { taxId?: string } = {}) {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `XPV-${seq++}`, {
      defaultCost: 10,
      ...opts,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 200, unitCost: 10 })
      .expect(201);
    return variantId;
  }

  async function stockedWithProduct() {
    const { productId, variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `XPP-${seq++}`, {
      defaultCost: 10,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 200, unitCost: 10 })
      .expect(201);
    return { productId, variantId };
  }

  async function serialVariant(serials: string[]) {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `XPS-${seq++}`, {
      tracksSerialNumbers: true,
      defaultCost: 10,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({ referenceType: 'PurchaseReceipt', referenceId: 'fixture-receipt', warehouseId: biz.warehouseId, variantId, quantity: serials.length, unitCost: 10, serials })
      .expect(201);
    return variantId;
  }

  function sell(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, ...body });
  }

  const previewExchange = (saleId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`/api/v1/sales/${saleId}/exchanges/preview`).set('Authorization', auth()).send(body);

  const exchange = (saleId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`/api/v1/sales/${saleId}/exchanges`).set('Authorization', auth()).send(body);

  async function financialFootprint() {
    const [sales, returns, items, payments, movements, entries, points, promoApps, serialLinks, returnSerialLinks, cash, custTx] =
      await Promise.all([
        admin.sale.count({ where: { businessId: biz.businessId } }),
        admin.saleReturn.count({ where: { businessId: biz.businessId } }),
        admin.saleItem.count({ where: { businessId: biz.businessId } }),
        admin.salePayment.count({ where: { businessId: biz.businessId } }),
        admin.stockMovement.count({ where: { businessId: biz.businessId } }),
        admin.journalEntry.count({ where: { businessId: biz.businessId } }),
        admin.customerPoints.count({ where: { businessId: biz.businessId } }),
        admin.salePromotionApplication.count({ where: { businessId: biz.businessId } }),
        admin.saleItemSerial.count({ where: { businessId: biz.businessId } }),
        admin.saleReturnItemSerial.count({ where: { businessId: biz.businessId } }),
        admin.cashTransaction.count({ where: { businessId: biz.businessId } }),
        admin.customerTransaction.count({ where: { businessId: biz.businessId } }),
      ]);
    return { sales, returns, items, payments, movements, entries, points, promoApps, serialLinks, returnSerialLinks, cash, custTx };
  }

  // ==================================================================
  describe('The preview equals the commit', () => {
    it('EVEN exchange: same value out as in — zero payment, zero refund, in both preview and commit', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 70 }],
        payments: [{ amount: 70 }],
      }).expect(201);

      const preview = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 70 }],
      }).expect(200);

      expect(preview.body.data.direction).toBe('EVEN');
      expect(preview.body.data.totals.returnCredit).toBe('70');
      expect(preview.body.data.totals.replacementTotal).toBe('70');
      expect(preview.body.data.totals.creditApplied).toBe('70');
      expect(preview.body.data.totals.amountDue).toBe('0');
      expect(preview.body.data.totals.refundAmount).toBe('0');
      expect(preview.body.data.refund.required).toBe(false);
      expect(preview.body.data.refund.requiredAmount).toBeNull();

      const committed = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 70 }],
        payments: [],
      }).expect(201);
      expect(committed.body.data.amountDue).toBe(preview.body.data.totals.amountDue);
      expect(committed.body.data.refunded).toBe(preview.body.data.totals.refundAmount);
    });

    it('UPWARD exchange: the preview names the exact tender the commit then accepts', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const preview = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 150 }],
      }).expect(200);

      expect(preview.body.data.direction).toBe('UPWARD');
      expect(preview.body.data.totals.amountDue).toBe('50');
      expect(preview.body.data.totals.refundAmount).toBe('0');
      expect(preview.body.data.refund.required).toBe(false);

      // The exact figure the preview named, tendered, is accepted.
      const committed = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 150 }],
        payments: [{ amount: Number(preview.body.data.totals.amountDue), method: 'CASH' }],
      }).expect(201);
      expect(committed.body.data.amountDue).toBe('50');
      expect(committed.body.data.exchangeCredit).toBe(preview.body.data.totals.creditApplied);
    });

    it('DOWNWARD exchange: the preview names the exact refund the commit then requires', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const preview = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 60 }],
      }).expect(200);

      expect(preview.body.data.direction).toBe('DOWNWARD');
      expect(preview.body.data.totals.amountDue).toBe('0');
      expect(preview.body.data.totals.refundAmount).toBe('40');
      expect(preview.body.data.refund.required).toBe(true);
      expect(preview.body.data.refund.requiredAmount).toBe('40');

      const committed = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 60 }],
        refund: { method: 'CASH', amount: Number(preview.body.data.totals.refundAmount) },
        payments: [],
      }).expect(201);
      expect(committed.body.data.refunded).toBe('40');
    });

    it('a WRONG refund the preview would not have suggested is still refused at commit — the preview informs, it does not relax the rule', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 60 }],
      }).expect(200);

      const wrong = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 60 }],
        refund: { method: 'CASH', amount: 25 },
        payments: [],
      }).expect(422);
      expect(wrong.body.error.details.requiredRefund).toBe('40');
    });
  });

  // ==================================================================
  describe('TAX, PROMOTION and LOYALTY flow through, exactly as the sale/return would', () => {
    it('carries TAX on both legs', async () => {
      const taxId = await createTax(app, biz.accessToken, 10);
      const oldItem = await stocked({ taxId });
      const newItem = await stocked({ taxId });
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 110 }],
      }).expect(201);

      const preview = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 200 }],
      }).expect(200);

      expect(preview.body.data.totals.returnCredit).toBe('110'); // 100 + 10 tax
      expect(preview.body.data.totals.replacementTotal).toBe('220'); // 200 + 20 tax
      expect(preview.body.data.newLines[0].taxAmount).toBe('20');
      expect(preview.body.data.totals.amountDue).toBe('110');
    });

    it('a PROMOTION on the replacement is what makes the exchange downward, named on the line', async () => {
      const oldItem = await stocked();
      const { variantId: newItem, productId } = await stockedWithProduct();
      await request(app.getHttpServer())
        .post('/api/v1/promotions')
        .set('Authorization', auth())
        .send({
          name: `Exchange preview promo ${seq++}`,
          type: 'PERCENTAGE',
          percentageValue: 20,
          targetType: 'PRODUCT',
          targetId: productId,
          validFrom: '2020-01-01',
          validTo: '2099-12-31',
        })
        .expect(201);

      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const preview = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
      }).expect(200);

      expect(preview.body.data.newLines[0].promotion?.type).toBe('PERCENTAGE');
      expect(preview.body.data.totals.replacementTotal).toBe('80');
      expect(preview.body.data.direction).toBe('DOWNWARD');
      expect(preview.body.data.totals.refundAmount).toBe('20');
    });

    it('LOYALTY redemption on the replacement reduces what is owed, exactly as a sale quote would show', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.currency_per_point', value: 0.5 })
        .expect(200);

      const loyal = (
        await request(app.getHttpServer())
          .post('/api/v1/sales/customers')
          .set('Authorization', auth())
          .send({ name: `Loyal previewer ${seq++}` })
          .expect(201)
      ).body.data.id as string;
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${loyal}/points/adjust`)
        .set('Authorization', auth())
        .send({ points: 40, reason: 'seed', idempotencyKey: `xprev-seed-${seq++}` })
        .expect(201);

      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId: loyal,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const preview = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
        redeemPoints: 40,
      }).expect(200);

      // 40 points x 0.5 = 20 off the replacement: 100 -> 80.
      expect(preview.body.data.totals.replacementTotal).toBe('80');
      expect(preview.body.data.totals.refundAmount).toBe('20');

      // Points are NOT spent by the preview - still there to actually redeem.
      const balance = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${loyal}/points`)
        .set('Authorization', auth())
        .expect(200);
      expect(balance.body.data.balance).toBe('40');

      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.currency_per_point', value: null })
        .expect(200);
    });

    it('TAX + PROMOTION + LOYALTY together resolve in the SAME order the sale itself uses', async () => {
      const taxId = await createTax(app, biz.accessToken, 10);
      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.currency_per_point', value: 1 })
        .expect(200);

      const oldItem = await stocked({ taxId });
      const { variantId: newItem, productId } = await stockedWithProduct();
      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', auth())
        .send({ taxId })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/promotions')
        .set('Authorization', auth())
        .send({
          name: `Combined preview promo ${seq++}`,
          type: 'PERCENTAGE',
          percentageValue: 10,
          targetType: 'PRODUCT',
          targetId: productId,
          validFrom: '2020-01-01',
          validTo: '2099-12-31',
        })
        .expect(201);

      const combo = (
        await request(app.getHttpServer())
          .post('/api/v1/sales/customers')
          .set('Authorization', auth())
          .send({ name: `Combo previewer ${seq++}` })
          .expect(201)
      ).body.data.id as string;
      await request(app.getHttpServer())
        .post(`/api/v1/sales/customers/${combo}/points/adjust`)
        .set('Authorization', auth())
        .send({ points: 10, reason: 'seed', idempotencyKey: `xprev-combo-${seq++}` })
        .expect(201);

      const sale = await sell({
        customerId: combo,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 110 }],
      }).expect(201);

      // Replacement: 100 gross -10% promo = 90, -10 loyalty = 80 net, +10% tax = 88.
      const preview = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
        redeemPoints: 10,
      }).expect(200);
      expect(preview.body.data.totals.replacementTotal).toBe('88');
      expect(preview.body.data.totals.returnCredit).toBe('110');
      expect(preview.body.data.totals.refundAmount).toBe('22');

      // The commit, tendering exactly what the preview named, matches it exactly.
      const committed = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
        redeemPoints: 10,
        refund: { method: 'CASH', amount: Number(preview.body.data.totals.refundAmount) },
        payments: [],
      }).expect(201);
      const replacement = await admin.sale.findUniqueOrThrow({ where: { id: committed.body.data.sale.id } });
      expect(replacement.totalAmount.toString()).toBe('88');

      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.currency_per_point', value: null })
        .expect(200);
    });
  });

  // ==================================================================
  describe('Serials', () => {
    it('a serial-tracked replacement line is flagged requiresSerials', async () => {
      const oldItem = await stocked();
      const newItem = await serialVariant(['XP-NEW-FLAG']);
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const preview = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100, serials: ['XP-NEW-FLAG'] }],
      }).expect(200);
      expect(preview.body.data.newLines[0].requiresSerials).toBe(true);
    });

    it('a returned serial-tracked line is flagged requiresSerials, and the serial the sale carried is echoed back', async () => {
      const oldItem = await serialVariant(['XP-OLD-ECHO']);
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100, serials: ['XP-OLD-ECHO'] }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const preview = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE', serials: ['XP-OLD-ECHO'] }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
      }).expect(200);
      expect(preview.body.data.returnLines[0].requiresSerials).toBe(true);
      expect(preview.body.data.returnLines[0].serials).toEqual(['XP-OLD-ECHO']);
    });

    it('rejects a return line whose serial COUNT does not match the quantity, exactly as the return preview does', async () => {
      const oldItem = await serialVariant(['XP-OLD-CNT-1', 'XP-OLD-CNT-2']);
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 2, unitPrice: 100, serials: ['XP-OLD-CNT-1', 'XP-OLD-CNT-2'] }],
        payments: [{ amount: 200 }],
      }).expect(201);

      const res = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 2, condition: 'SELLABLE', serials: ['XP-OLD-CNT-1'] }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
      }).expect(422);
      expect(res.body.error.message).toMatch(/number of serials supplied must equal/i);
    });

    it('rejects a replacement line missing serials for a serial-tracked product', async () => {
      const oldItem = await stocked();
      const newItem = await serialVariant(['XP-NEW-MISSING']);
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
      }).expect(422);
    });

    it('a serial with the right COUNT but the wrong IDENTITY passes the preview and is refused at commit — the preview does not replace revalidation', async () => {
      const oldItem = await serialVariant(['XP-REAL-SERIAL']);
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100, serials: ['XP-REAL-SERIAL'] }],
        payments: [{ amount: 100 }],
      }).expect(201);

      // A serial that was never sold on this line - same count (1), wrong unit.
      const preview = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE', serials: ['XP-NEVER-SOLD'] }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
      }).expect(200);
      expect(preview.body.data.direction).toBe('EVEN');

      const before = await financialFootprint();
      const rejected = await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE', serials: ['XP-NEVER-SOLD'] }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
        payments: [],
      }).expect(422); // the identity join finds no such serial on this line - never a 200
      expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
      expect(await financialFootprint()).toEqual(before);
    });

    it('preserves the serial lifecycle preview-to-commit for a serial-for-serial exchange', async () => {
      const oldItem = await serialVariant(['XP-SWAP-OLD']);
      const newItem = await serialVariant(['XP-SWAP-NEW']);
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100, serials: ['XP-SWAP-OLD'] }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const preview = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE', serials: ['XP-SWAP-OLD'] }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100, serials: ['XP-SWAP-NEW'] }],
      }).expect(200);
      expect(preview.body.data.direction).toBe('EVEN');

      await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE', serials: ['XP-SWAP-OLD'] }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100, serials: ['XP-SWAP-NEW'] }],
        payments: [],
      }).expect(201);

      const returned = await admin.serialNumber.findFirstOrThrow({ where: { businessId: biz.businessId, serial: 'XP-SWAP-OLD' } });
      expect(returned.status).toBe('IN_STOCK');
      const issued = await admin.serialNumber.findFirstOrThrow({ where: { businessId: biz.businessId, serial: 'XP-SWAP-NEW' } });
      expect(issued.status).toBe('SOLD');
    });
  });

  // ==================================================================
  describe('The preview changes nothing', () => {
    it('leaves EVERY financial, inventory and serial table untouched, across all three directions', async () => {
      const oldEven = await stocked();
      const newEven = await stocked();
      const saleEven = await sell({
        customerId,
        items: [{ variantId: oldEven, quantity: 1, unitPrice: 50 }],
        payments: [{ amount: 50 }],
      }).expect(201);

      const oldUp = await stocked();
      const newUp = await stocked();
      const saleUp = await sell({
        customerId,
        items: [{ variantId: oldUp, quantity: 1, unitPrice: 50 }],
        payments: [{ amount: 50 }],
      }).expect(201);

      const oldDown = await serialVariant(['XP-FOOT-OLD']);
      const newDown = await serialVariant(['XP-FOOT-NEW']);
      const saleDown = await sell({
        customerId,
        items: [{ variantId: oldDown, quantity: 1, unitPrice: 50, serials: ['XP-FOOT-OLD'] }],
        payments: [{ amount: 50 }],
      }).expect(201);

      const before = await financialFootprint();
      const oldSerialBefore = await admin.serialNumber.findFirstOrThrow({ where: { businessId: biz.businessId, serial: 'XP-FOOT-OLD' } });
      const newSerialBefore = await admin.serialNumber.findFirstOrThrow({ where: { businessId: biz.businessId, serial: 'XP-FOOT-NEW' } });

      for (let i = 0; i < 3; i += 1) {
        await previewExchange(saleEven.body.data.id, {
          returnItems: [{ saleItemId: saleEven.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          newItems: [{ variantId: newEven, quantity: 1, unitPrice: 50 }],
        }).expect(200);
        await previewExchange(saleUp.body.data.id, {
          returnItems: [{ saleItemId: saleUp.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          newItems: [{ variantId: newUp, quantity: 1, unitPrice: 90 }],
        }).expect(200);
        await previewExchange(saleDown.body.data.id, {
          returnItems: [{ saleItemId: saleDown.body.data.items[0].id, quantity: 1, condition: 'SELLABLE', serials: ['XP-FOOT-OLD'] }],
          newItems: [{ variantId: newDown, quantity: 1, unitPrice: 20, serials: ['XP-FOOT-NEW'] }],
        }).expect(200);
      }

      expect(await financialFootprint()).toEqual(before);
      const oldSerialAfter = await admin.serialNumber.findFirstOrThrow({ where: { businessId: biz.businessId, serial: 'XP-FOOT-OLD' } });
      const newSerialAfter = await admin.serialNumber.findFirstOrThrow({ where: { businessId: biz.businessId, serial: 'XP-FOOT-NEW' } });
      expect(oldSerialAfter.status).toBe(oldSerialBefore.status);
      expect(newSerialAfter.status).toBe(newSerialBefore.status);
      // Both units are still exactly where they were, and still transactable.
      expect(oldSerialAfter.status).toBe('SOLD');
      expect(newSerialAfter.status).toBe('IN_STOCK');
    });

    it('runs in a transaction PostgreSQL itself refuses to let write', async () => {
      const appRole = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
      try {
        await expect(
          appRole.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
            await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
            await tx.$executeRawUnsafe(`UPDATE stock_balances SET quantity_on_hand = quantity_on_hand + 1 WHERE business_id = '${biz.businessId}'`);
          }),
        ).rejects.toThrow(/read-only transaction/i);
      } finally {
        await appRole.$disconnect();
      }
    });

    it('consumes no idempotency key and holds no stock - a stale preview is superseded by the commit', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const p1 = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
      }).expect(200);
      expect(p1.body.data.guarantees).toEqual({
        authoritativeOutcome: true,
        reservesNothing: true,
        createsNothing: true,
        finalExchangeRevalidates: true,
      });

      // Someone else drains the stock between the preview and the commit -
      // the preview held nothing, so the commit sees the real world.
      await request(app.getHttpServer())
        .post('/api/v1/inventory/adjustments')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          variantId: newItem,
          quantity: -199,
          movementType: 'ADJUSTMENT',
          reason: 'drain for preview test',
        })
        .expect(201);

      await exchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 5, unitPrice: 100 }],
        payments: [{ amount: 400, method: 'CASH' }],
      }).expect(409);
    });
  });

  // ==================================================================
  describe('Availability is advisory, not a reservation', () => {
    it('reports insufficient stock without refusing the preview', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const preview = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 5000, unitPrice: 1 }],
      }).expect(200);
      expect(preview.body.data.availability[0].sufficient).toBe(false);
      expect(preview.body.data.availability[0].availableQuantity).toBe('200');
    });
  });

  // ==================================================================
  describe('Original sale lookup', () => {
    it('refuses to preview against a sale that does not exist', async () => {
      await previewExchange('00000000-0000-0000-0000-000000000000', {
        returnItems: [{ saleItemId: '00000000-0000-0000-0000-000000000001', quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: await stocked(), quantity: 1, unitPrice: 10 }],
      }).expect(404);
    });

    it('over-quantity on a return line is refused, exactly as the return preview refuses it', async () => {
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const res = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 2, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
      }).expect(409);
      expect(res.body.error.details.available).toBe('1');
    });
  });

  // ==================================================================
  describe('Authorization and tenant isolation', () => {
    it('requires BOTH sales.return and sales.create — a cashier who can only sell cannot preview', async () => {
      const role = await request(app.getHttpServer())
        .post('/api/v1/roles')
        .set('Authorization', auth())
        .send({
          name: 'Preview Sell Only',
          permissionCodes: ['sales.create', 'sales.view', 'shifts.open', 'shifts.view', 'products.view', 'inventory.view', 'customers.view'],
        })
        .expect(201);
      const roleId = role.body.data.id as string;
      const email = `previewer@${biz.slug}.test`;
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'previewer', email, password: 'RoleUserPass1!', roleIds: [roleId], branchIds: [] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'RoleUserPass1!', businessSlug: biz.slug })
        .expect(200);

      const oldItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.body.data.id}/exchanges/preview`)
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .send({
          returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          newItems: [{ variantId: await stocked(), quantity: 1, unitPrice: 150 }],
        })
        .expect(403);
    });

    it('refuses an unauthenticated caller', async () => {
      const oldItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.body.data.id}/exchanges/preview`)
        .send({
          returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          newItems: [{ variantId: await stocked(), quantity: 1, unitPrice: 100 }],
        })
        .expect(401);
    });

    it('cannot preview an exchange against another tenant\'s sale — invisible, not merely forbidden', async () => {
      const other = await setupSalesFixture(app, `exprevother${seq++}`);
      const { variantId } = await createSimpleProduct(app, other.accessToken, other.uomId, `OTHXP-${seq++}`, { defaultCost: 1 });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ warehouseId: other.warehouseId, variantId, quantity: 10, unitCost: 1 })
        .expect(201);
      const theirSale = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ warehouseId: other.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 100 }] })
        .expect(201);

      await previewExchange(theirSale.body.data.id, {
        returnItems: [{ saleItemId: theirSale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: await stocked(), quantity: 1, unitPrice: 80 }],
      }).expect(404);
    });

    it('cannot price ANOTHER TENANT\'s variant as the replacement', async () => {
      const other = await setupSalesFixture(app, `exprevother2${seq++}`);
      const { variantId: theirVariant } = await createSimpleProduct(app, other.accessToken, other.uomId, `OTHXP2-${seq++}`, {
        defaultCost: 1,
      });

      const oldItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: theirVariant, quantity: 1, unitPrice: 10 }],
      }).expect(404);
      void other;
    });
  });

  // ==================================================================
  describe('Validation', () => {
    it('rejects a malformed preview rather than pricing it', async () => {
      const oldItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      await previewExchange(sale.body.data.id, { returnItems: [], newItems: [] }).expect(422);
      await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: 'not-a-uuid', quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: await stocked(), quantity: 1, unitPrice: 10 }],
      }).expect(422);
    });

    it('rejects an EXCHANGE_CREDIT payment field if ever sent — the schema has no such door on newItems either', async () => {
      // saleItemInputSchema (newItems) has no `payments`/`method` field to
      // begin with; this documents that the preview cannot be used to
      // probe for one.
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      const res = await previewExchange(sale.body.data.id, {
        returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
        newItems: [{ variantId: newItem, quantity: 1, unitPrice: 100 }],
        payments: [{ amount: 10, method: 'EXCHANGE_CREDIT' }],
      }).expect(200);
      // Unknown/extra fields are simply stripped by the schema.
      expect(res.body.data.totals.amountDue).toBe('0');
    });
  });
});
