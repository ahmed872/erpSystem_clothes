import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 12 (POS loose ends) — the three approved contract changes, and the
 * one capability the POS was ignoring.
 *
 *   D1 customer search by name OR phone, exact phone first
 *   D3 the configured price list is authoritative for the selling price
 *   D4 exact serial lookup, and nothing broader
 *   D5 a BUNDLE can actually be sold through `POST /sales`
 */
describe('POS loose ends: D1/D3/D4/D5 (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let other: SalesFixture;
  let seq = 0;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'loose-a');
    other = await setupSalesFixture(app, 'loose-b');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;
  const server = () => app.getHttpServer();

  async function stocked(qty = 50, opts: Record<string, unknown> = {}) {
    const { productId, variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `LOOSE-${seq++}`, {
      defaultCost: 10,
      defaultSellingPrice: 100,
      ...opts,
    });
    await request(server())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: qty, unitCost: 10 })
      .expect(201);
    return { productId, variantId };
  }

  /** A user holding exactly `permissionCodes`. */
  async function userWith(permissionCodes: string[], label: string) {
    const role = await request(server())
      .post('/api/v1/roles')
      .set('Authorization', auth())
      .send({ name: `${label} ${seq++}`, permissionCodes })
      .expect(201);
    const email = `${label.toLowerCase().replace(/\s+/g, '-')}-${seq}@${biz.slug}.test`;
    await request(server())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: label, email, password: 'LoosePass1!', roleIds: [role.body.data.id], branchIds: [biz.branchId] })
      .expect(201);
    const login = await request(server())
      .post('/api/v1/auth/login')
      .send({ businessSlug: biz.slug, email, password: 'LoosePass1!' })
      .expect(200);
    return `Bearer ${login.body.data.accessToken}`;
  }

  // ==================================================================
  describe('D1 — a till finds a customer by name OR phone', () => {
    const search = (term: string, token = auth()) =>
      request(server()).get('/api/v1/sales/customers').set('Authorization', token).query({ search: term });

    let exactId: string;

    beforeAll(async () => {
      const make = async (name: string, phone?: string) => {
        const res = await request(server())
          .post('/api/v1/sales/customers')
          .set('Authorization', auth())
          .send({ name, ...(phone ? { phone } : {}) })
          .expect(201);
        return res.body.data.id as string;
      };
      await make('Zainab Al-Masri', '01009998888');
      exactId = await make('Ahmed Hassan', '01001234567');
      await make('Mona Farouk', '010012345');
      await make('Youssef Adel');
    });

    it('still finds by NAME, exactly as before', async () => {
      const res = await search('Hassan').expect(200);
      expect(res.body.data.map((c: { name: string }) => c.name)).toContain('Ahmed Hassan');
    });

    it('finds by PHONE, which it could not do at all before', async () => {
      const res = await search('01009998888').expect(200);
      expect(res.body.data.map((c: { name: string }) => c.name)).toEqual(['Zainab Al-Masri']);
    });

    it('EXACT PHONE RANKS FIRST, above the substring matches that contain it', async () => {
      // '010012345' is a prefix of '01001234567', so a plain `contains`
      // search returns both. The person who just read out their whole
      // number must not be buried under the other one.
      const res = await search('01001234567').expect(200);
      expect(res.body.data[0].id).toBe(exactId);

      // And searching the SHORTER number puts its own exact owner first,
      // even though the longer one also contains it.
      const shorter = await search('010012345').expect(200);
      expect(shorter.body.data[0].name).toBe('Mona Farouk');
      expect(shorter.body.data.map((c: { name: string }) => c.name)).toContain('Ahmed Hassan');
    });

    it('a customer with NO phone never outranks a real match', async () => {
      const res = await search('01001234567').expect(200);
      expect(res.body.data.map((c: { name: string }) => c.name)).not.toContain('Youssef Adel');
    });

    it('TENANT ISOLATION: another business searching the same number finds nothing', async () => {
      const res = await search('01001234567', `Bearer ${other.accessToken}`).expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('a wildcard is searched literally, not as "match everybody"', async () => {
      const res = await search('%').expect(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // ==================================================================
  describe('D3 — the configured price list is the selling price', () => {
    let priceListId: string;

    beforeAll(async () => {
      const list = await request(server())
        .post('/api/v1/catalog/price-lists')
        .set('Authorization', auth())
        .send({ name: `POS Retail ${seq++}`, isDefault: true })
        .expect(201);
      priceListId = list.body.data.id;
    });

    const configure = (variantId: string, price: number) =>
      request(server())
        .put(`/api/v1/catalog/price-lists/${priceListId}/prices`)
        .set('Authorization', auth())
        .send({ variantId, price })
        .expect((r) => {
          if (![200, 201].includes(r.status)) throw new Error(`configure failed: ${r.status} ${JSON.stringify(r.body)}`);
        });

    /**
     * A till user who may sell but may NOT set a price - the case D3
     * exists for. They need a register and shift of their own: the owner
     * already holds the default one, and pricing validates the caller's
     * own open shift.
     */
    async function tillUserWithoutPriceOverride() {
      const token = await userWith(
        ['sales.create', 'sales.view', 'products.view', 'inventory.view', 'shifts.view', 'shifts.open', 'cash_registers.view'],
        'Priced cashier',
      );
      const till = await request(server())
        .post('/api/v1/cash-registers')
        .set('Authorization', auth())
        .send({ branchId: biz.branchId, name: `Priced till ${seq}`, code: `PRICED-${seq++}` })
        .expect(201);
      await request(server())
        .post('/api/v1/sales/shifts/open')
        .set('Authorization', token)
        .send({ warehouseId: biz.warehouseId, cashRegisterId: till.body.data.id, openingFloat: 0 })
        .expect(201);
      return token;
    }

    it('THE QUOTE CHARGES THE SHOP PRICE, not the one the browser sent', async () => {
      const { variantId } = await stocked();
      await configure(variantId, 80);

      // A till whose catalogue copy is stale, or which was tampered with.
      const cashier = await tillUserWithoutPriceOverride();
      const quote = await request(server())
        .post('/api/v1/sales/quote')
        .set('Authorization', cashier)
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 2, unitPrice: 100 }] })
        .expect(200);

      // 2 x 80, never 2 x 100.
      expect(quote.body.data.totals.amountDue).toBe('160');
      expect(quote.body.data.lines[0].unitPrice).toBe('80');
    });

    it('AND THE SALE CHARGES IT TOO - the quote and the sale cannot disagree', async () => {
      const { variantId } = await stocked();
      await configure(variantId, 80);
      const cashier = await tillUserWithoutPriceOverride();

      // Tendering the price the BROWSER thought applied is refused,
      // because the server's total is 160 - so a till cannot reach the
      // shop price by simply paying its own.
      const refused = await request(server())
        .post('/api/v1/sales')
        .set('Authorization', cashier)
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId, quantity: 2, unitPrice: 100 }],
          payments: [{ amount: 200, method: 'CASH' }],
        });
      expect(refused.status).toBeGreaterThanOrEqual(400);

      const ok = await request(server())
        .post('/api/v1/sales')
        .set('Authorization', cashier)
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId, quantity: 2, unitPrice: 100 }],
          payments: [{ amount: 160, method: 'CASH' }],
        })
        .expect(201);
      expect(ok.body.data.totalAmount).toBe('160');
      // The PERSISTED price is the shop's, so the sale, its receipt and
      // any later return all describe what was really charged.
      expect(ok.body.data.items[0].unitPrice).toBe('80');
    });

    it('products.change_price REMAINS a legitimate override', async () => {
      const { variantId } = await stocked();
      await configure(variantId, 80);

      // The owner holds `products.change_price` - a damaged-goods
      // markdown, a haggled deal. Their figure stands.
      const res = await request(server())
        .post('/api/v1/sales/quote')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 55 }] })
        .expect(200);
      expect(res.body.data.totals.amountDue).toBe('55');
    });

    it('a variant with NO configured price is unaffected - which is every existing sale', async () => {
      const { variantId } = await stocked();
      const res = await request(server())
        .post('/api/v1/sales/quote')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 37 }] })
        .expect(200);
      expect(res.body.data.totals.amountDue).toBe('37');
    });

    it('HISTORICAL PRICES ARE IMMUTABLE: repricing later never rewrites a past sale', async () => {
      const { variantId } = await stocked();
      await configure(variantId, 80);
      const sale = await request(server())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId, quantity: 1, unitPrice: 80 }],
          payments: [{ amount: 80, method: 'CASH' }],
        })
        .expect(201);

      await configure(variantId, 999);

      const after = await admin.saleItem.findFirstOrThrow({ where: { saleId: sale.body.data.id } });
      expect(after.unitPrice.toString()).toBe('80');
      const reread = await request(server()).get(`/api/v1/sales/${sale.body.data.id}`).set('Authorization', auth()).expect(200);
      expect(reread.body.data.totalAmount).toBe('80');
    });
  });

  // ==================================================================
  describe('D4 — exact serial lookup, and nothing broader', () => {
    let soldSerial: string;
    let saleNumber: string;
    let saleId: string;
    let saleItemId: string;
    let unsoldSerial: string;

    beforeAll(async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `LOOSE-SER-${seq++}`, {
        tracksSerialNumbers: true,
        defaultCost: 100,
        defaultSellingPrice: 500,
      });
      soldSerial = `LOOSE-SOLD-${seq}`;
      unsoldSerial = `LOOSE-UNSOLD-${seq}`;
      await request(server())
        .post('/api/v1/inventory/receipts')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 2, unitCost: 100, serials: [soldSerial, unsoldSerial] })
        .expect(201);
      const sale = await request(server())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId, quantity: 1, unitPrice: 500, serials: [soldSerial] }],
          payments: [{ amount: 500, method: 'CASH' }],
        })
        .expect(201);
      saleId = sale.body.data.id;
      saleNumber = sale.body.data.saleNumber;
      saleItemId = sale.body.data.items[0].id;
    });

    const lookup = (serial: string, token = auth()) =>
      request(server()).get('/api/v1/sales/serial-lookup').set('Authorization', token).query({ serial });

    it('reaches the SALE that delivered the unit, with what Returns and Warranty need to start', async () => {
      const res = await lookup(soldSerial).expect(200);
      expect(res.body.data.serial).toBe(soldSerial);
      expect(res.body.data.status).toBe('SOLD');
      expect(res.body.data.sale).toMatchObject({ id: saleId, saleNumber, saleItemId });
      expect(res.body.data.serialNumberId).toEqual(expect.any(String));
    });

    it('EXPOSES NO COST OR MARGIN, and no unrelated unit', async () => {
      const res = await lookup(soldSerial).expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/"cost"|averageCost|margin|profit/i);
      expect(body).not.toContain(unsoldSerial);
    });

    it('a received but UNSOLD unit answers truthfully rather than 404ing', async () => {
      const res = await lookup(unsoldSerial).expect(200);
      expect(res.body.data.status).toBe('IN_STOCK');
      expect(res.body.data.sale).toBeNull();
    });

    it('is EXACT: a prefix of a real serial finds nothing', async () => {
      await lookup(soldSerial.slice(0, 6)).expect(404);
      await lookup('%').expect(404);
    });

    it('TENANT ISOLATION: another business cannot resolve this shop\'s serial', async () => {
      await lookup(soldSerial, `Bearer ${other.accessToken}`).expect(404);
    });

    it('PERMISSION: a caller without sales.view is refused', async () => {
      const noSales = await userWith(['products.view', 'inventory.view'], 'No sales view');
      await lookup(soldSerial, noSales).expect(403);
    });
  });

  // ==================================================================
  describe('D5 — a bundle can actually be sold', () => {
    it('SELLS a bundle: components leave stock, the bundle itself never does', async () => {
      const { variantId: componentA } = await stocked(100);
      const { variantId: componentB } = await stocked(100);

      const bundle = await request(server())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({
          sku: `LOOSE-BUNDLE-${seq++}`,
          name: 'Gift set',
          type: 'BUNDLE',
          baseUomId: biz.uomId,
          defaultCost: 0,
          defaultSellingPrice: 250,
          bundleItems: [
            { variantId: componentA, quantity: 1 },
            { variantId: componentB, quantity: 2 },
          ],
        })
        .expect(201);
      const bundleVariantId = bundle.body.data.variants[0].id;

      const sale = await request(server())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId: bundleVariantId, quantity: 3, unitPrice: 250 }],
          payments: [{ amount: 750, method: 'CASH' }],
        })
        .expect(201);

      // A real sale, with the bundle as the line the customer bought.
      expect(sale.body.data.totalAmount).toBe('750');
      expect(sale.body.data.items[0].variantId).toBe(bundleVariantId);

      // INVENTORY IS THE BACKEND'S: 3 x 1 of A and 3 x 2 of B, and the
      // bundle variant itself carries no balance at all.
      const balanceA = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: componentA } });
      const balanceB = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: componentB } });
      expect(balanceA.quantityOnHand.toString()).toBe('97');
      expect(balanceB.quantityOnHand.toString()).toBe('94');
      expect(await admin.stockBalance.findFirst({ where: { businessId: biz.businessId, variantId: bundleVariantId } })).toBeNull();

      const movements = await admin.stockMovement.findMany({
        where: { businessId: biz.businessId, referenceType: 'Sale', referenceId: sale.body.data.id },
      });
      expect(movements.map((m) => m.movementType).sort()).toEqual(['BUNDLE_CONSUMPTION', 'BUNDLE_CONSUMPTION']);
      expect(movements.every((m) => m.variantId !== bundleVariantId)).toBe(true);

      // ACCOUNTING IS THE BACKEND'S: one balanced entry for the sale.
      const entry = await admin.journalEntry.findFirstOrThrow({
        where: { sourceType: 'Sale', sourceId: sale.body.data.id },
        include: { lines: true },
      });
      const debits = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
      const credits = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(debits).toBeCloseTo(credits, 4);

      // And the receipt reads as the customer's purchase.
      const receipt = await request(server()).get(`/api/v1/sales/${sale.body.data.id}/receipt`).set('Authorization', auth()).expect(200);
      expect(receipt.body.data.items[0].name).toBe('Gift set');
      expect(receipt.body.data.sale.totalAmount).toBe('750');
    });

    it('a bundle short of ONE component rolls the whole sale back', async () => {
      const { variantId: plenty } = await stocked(100);
      const { variantId: scarce } = await stocked(1);

      const bundle = await request(server())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({
          sku: `LOOSE-BUNDLE-SHORT-${seq++}`,
          name: 'Short set',
          type: 'BUNDLE',
          baseUomId: biz.uomId,
          defaultCost: 0,
          defaultSellingPrice: 100,
          bundleItems: [
            { variantId: plenty, quantity: 1 },
            { variantId: scarce, quantity: 1 },
          ],
        })
        .expect(201);

      const salesBefore = await admin.sale.count({ where: { businessId: biz.businessId } });
      await request(server())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId: bundle.body.data.variants[0].id, quantity: 5, unitPrice: 100 }],
          payments: [{ amount: 500, method: 'CASH' }],
        })
        // Short stock is a CONFLICT with the shelf, not a malformed request.
        .expect(409);

      expect(await admin.sale.count({ where: { businessId: biz.businessId } })).toBe(salesBefore);
      const plentyBalance = await admin.stockBalance.findFirstOrThrow({ where: { businessId: biz.businessId, variantId: plenty } });
      expect(plentyBalance.quantityOnHand.toString()).toBe('100');
    });
  });
});
