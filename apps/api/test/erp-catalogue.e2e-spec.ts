import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';

/**
 * Phase 14 — ERP PRODUCT CATALOGUE + PRICING.
 *
 * WHAT THIS SPEC IS FOR. The catalogue contracts already existed and the
 * ERP added none; `catalog-products.e2e-spec.ts` and
 * `catalog-price-lists.e2e-spec.ts` already prove they work. What was NOT
 * proved is the set of claims the ERP catalogue screens actually make:
 *
 *   - cost is stripped from WRITE responses, not only read ones (a defect
 *     this milestone found and fixed — see `stripProductCost`);
 *   - `products.edit`, `products.change_cost` and `products.change_price`
 *     are three separate grants, and the ERP's three separate controls
 *     match three separate refusals;
 *   - configuring a price in the ERP changes what the POS CHARGES, end to
 *     end, without the browser deciding anything;
 *   - a deactivated default price list stops applying — the state the
 *     price-list screen warns about;
 *   - none of it crosses a tenant boundary.
 *
 * Roles come from the live templates. The one that matters most here is
 * INVENTORY_MANAGER: they hold `products.create`, `products.edit` and
 * `products.change_cost` but NOT `products.change_price`, and no
 * price-list grant beyond `view`. They build the catalogue; they do not
 * price the shop.
 */
describe('ERP catalogue and pricing (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let other: SalesFixture;

  let ownerToken: string;
  let stockToken: string;
  /** A CUSTOM role: may edit and price, may NOT see cost. */
  let merchandiserToken: string;
  /** A CUSTOM role: may view the catalogue only. */
  let viewerToken: string;

  let productId: string;
  let variantId: string;
  let priceListId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    biz = await setupSalesFixture(app, 'erp-cat-a');
    other = await setupSalesFixture(app, 'erp-cat-b');
    ownerToken = biz.accessToken;

    stockToken = await userOnTemplate('INVENTORY_MANAGER', 'stock');
    merchandiserToken = await userOnCustomRole('MERCHANDISER', 'merch', [
      'products.view',
      'products.create',
      'products.edit',
      'products.change_price',
      'pricelists.view',
      'pricelists.manage_prices',
    ]);
    viewerToken = await userOnCustomRole('VIEWER', 'viewer', ['products.view', 'pricelists.view']);

    const product = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', bearer(ownerToken))
      .send({
        sku: 'ERP-CAT-1',
        name: 'Leather Jacket',
        alternativeName: 'جاكيت جلد',
        baseUomId: biz.uomId,
        defaultCost: 400,
        defaultSellingPrice: 1200,
      })
      .expect(201);
    productId = product.body.data.id;
    variantId = product.body.data.variants[0].id;

    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', bearer(ownerToken))
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 50, unitCost: 400 })
      .expect(201);
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

  /** Custom roles are a first-class feature, which is exactly why the ERP
   *  authorizes by grant and never by role name. */
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

  // ================================================================
  // 1. Listing, search and filtering — all server-side
  // ================================================================
  describe('product listing and search', () => {
    it('returns the paginated shape the catalogue screen renders', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/catalog/products')
        .set('Authorization', bearer(ownerToken))
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({
          page: expect.any(Number),
          limit: expect.any(Number),
          total: expect.any(Number),
          totalPages: expect.any(Number),
        }),
      );
      // The list row carries what the table's columns need, and the
      // browser derives none of it.
      const row = res.body.data.find((p: { id: string }) => p.id === productId);
      expect(row).toEqual(
        expect.objectContaining({ sku: 'ERP-CAT-1', name: 'Leather Jacket', type: 'SIMPLE', status: 'ACTIVE' }),
      );
      expect(row.variants).toHaveLength(1);
    });

    it('searches by name, SKU and the ARABIC alternative name', async () => {
      const find = async (search: string) =>
        (
          await request(app.getHttpServer())
            .get(`/api/v1/catalog/products?search=${encodeURIComponent(search)}`)
            .set('Authorization', bearer(ownerToken))
            .expect(200)
        ).body.data.map((p: { id: string }) => p.id);

      expect(await find('Leather')).toContain(productId);
      expect(await find('ERP-CAT')).toContain(productId);
      // Arabic-first is not decoration: a merchant types the name they use.
      expect(await find('جاكيت')).toContain(productId);
      expect(await find('nothing-matches-this')).not.toContain(productId);
    });

    it('filters by status and type, and PAGINATES — the browser filters nothing', async () => {
      const inactive = await request(app.getHttpServer())
        .get('/api/v1/catalog/products?status=INACTIVE')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(inactive.body.data.map((p: { id: string }) => p.id)).not.toContain(productId);

      const bundles = await request(app.getHttpServer())
        .get('/api/v1/catalog/products?type=BUNDLE')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(bundles.body.data.every((p: { type: string }) => p.type === 'BUNDLE')).toBe(true);

      // A count that reflects the WHOLE match, not the page — which is why
      // the screen never counts rows itself.
      const paged = await request(app.getHttpServer())
        .get('/api/v1/catalog/products?limit=1&page=1')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(paged.body.data).toHaveLength(1);
      expect(paged.body.pagination.total).toBeGreaterThanOrEqual(1);
    });
  });

  // ================================================================
  // 2. Cost protection — the defect this milestone found
  // ================================================================
  describe('cost protection', () => {
    it('STRIPS cost from write responses, not only reads (the Phase 14 fix)', async () => {
      // Before this milestone `PATCH /catalog/products/:id`,
      // `PATCH /catalog/variants/:id`, `PATCH /catalog/variants/:id/price`
      // and `POST /catalog/products/:id/variants` each returned the
      // freshly-written row verbatim, cost included, to a caller who could
      // not read cost anywhere else. Reachable, not theoretical: `edit`
      // and `view_cost` are separate grants.
      const read = await request(app.getHttpServer())
        .get(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(merchandiserToken))
        .expect(200);
      expect(read.body.data).not.toHaveProperty('defaultCost');
      expect(read.body.data.variants[0]).not.toHaveProperty('cost');

      const renamed = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(merchandiserToken))
        .send({ description: 'Full-grain leather' })
        .expect(200);
      expect(renamed.body.data).not.toHaveProperty('defaultCost');

      const touched = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${variantId}`)
        .set('Authorization', bearer(merchandiserToken))
        .send({ status: 'ACTIVE' })
        .expect(200);
      expect(touched.body.data).not.toHaveProperty('cost');

      const repriced = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${variantId}/price`)
        .set('Authorization', bearer(merchandiserToken))
        .send({ sellingPrice: 1250 })
        .expect(200);
      expect(repriced.body.data).not.toHaveProperty('cost');
      // The write itself still happened.
      expect(repriced.body.data.sellingPrice).toEqual(expect.any(String));

      const added = await request(app.getHttpServer())
        .post(`/api/v1/catalog/products/${productId}/variants`)
        .set('Authorization', bearer(merchandiserToken))
        .send({ sku: 'ERP-CAT-1-B' })
        .expect(201);
      expect(added.body.data).not.toHaveProperty('cost');
    });

    it('still SENDS cost to a caller who holds products.view_cost', async () => {
      // The other half: the fix must not blind an authorized user.
      const read = await request(app.getHttpServer())
        .get(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(read.body.data).toHaveProperty('defaultCost');
      expect(read.body.data.variants[0]).toHaveProperty('cost');

      const written = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(ownerToken))
        .send({ description: 'Full-grain leather' })
        .expect(200);
      expect(written.body.data).toHaveProperty('defaultCost');

      const costed = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${variantId}/cost`)
        .set('Authorization', bearer(ownerToken))
        .send({ cost: 420 })
        .expect(200);
      expect(Number(costed.body.data.cost)).toBe(420);
    });
  });

  // ================================================================
  // 3. The separate grants the ERP's separate controls mirror
  // ================================================================
  describe('permission boundaries', () => {
    it('INVENTORY_MANAGER may build the catalogue and set COST', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', bearer(stockToken))
        .send({ sku: 'ERP-CAT-STOCK', name: 'Stocked item', baseUomId: biz.uomId, defaultCost: 10, defaultSellingPrice: 30 })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${created.body.data.variants[0].id}/cost`)
        .set('Authorization', bearer(stockToken))
        .send({ cost: 12 })
        .expect(200);
    });

    it('...but may NOT set the shelf price, nor reprice the shop', async () => {
      // This is why the ERP offers "Set price" and "Set cost" as two
      // controls behind two permission checks rather than one Save.
      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${variantId}/price`)
        .set('Authorization', bearer(stockToken))
        .send({ sellingPrice: 1 })
        .expect(403);

      await request(app.getHttpServer())
        .post('/api/v1/catalog/price-lists')
        .set('Authorization', bearer(stockToken))
        .send({ name: 'Stock manager list' })
        .expect(403);
    });

    it('a view-only role is refused every write in the catalogue', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', bearer(viewerToken))
        .send({ sku: 'NOPE-1', name: 'Nope', baseUomId: biz.uomId })
        .expect(403);

      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(viewerToken))
        .send({ name: 'Renamed by a viewer' })
        .expect(403);

      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${variantId}/cost`)
        .set('Authorization', bearer(viewerToken))
        .send({ cost: 1 })
        .expect(403);

      // ...and nothing was written.
      const product = await admin.product.findUniqueOrThrow({ where: { id: productId } });
      expect(product.name).toBe('Leather Jacket');
    });

    it('refuses reference-data writes without their own grants', async () => {
      // Categories, brands, attributes, units and taxes each carry their
      // own codes — which is why the setup screen gates each TAB.
      for (const [path, body] of [
        ['/api/v1/catalog/categories', { name: 'Nope' }],
        ['/api/v1/catalog/brands', { name: 'Nope' }],
        ['/api/v1/catalog/attributes', { name: 'Nope' }],
        ['/api/v1/catalog/uoms', { name: 'Nope', code: 'NP' }],
        ['/api/v1/taxes', { name: 'Nope', ratePercent: 5 }],
      ] as const) {
        await request(app.getHttpServer()).post(path).set('Authorization', bearer(viewerToken)).send(body).expect(403);
      }
    });
  });

  // ================================================================
  // 4. SKU and barcode rules
  // ================================================================
  describe('SKU and barcode validation', () => {
    it('refuses a duplicate SKU across BOTH products and variants', async () => {
      // One flat namespace, enforced in `assertSkuAvailable`, so a
      // search-by-SKU can never be ambiguous about which table it hit.
      const dupProduct = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', bearer(ownerToken))
        .send({ sku: 'ERP-CAT-1', name: 'Clashing product', baseUomId: biz.uomId })
        .expect(409);
      expect(dupProduct.body.error.code).toBe('CONFLICT');

      await request(app.getHttpServer())
        .post(`/api/v1/catalog/products/${productId}/variants`)
        .set('Authorization', bearer(ownerToken))
        .send({ sku: 'ERP-CAT-1-B' })
        .expect(409);
    });

    it('refuses a malformed SKU with a 422 rather than storing it', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', bearer(ownerToken))
        .send({ sku: 'has spaces', name: 'Bad', baseUomId: biz.uomId })
        .expect(422);
    });

    it('adds a barcode and refuses a duplicate one', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/catalog/variants/${variantId}/barcodes`)
        .set('Authorization', bearer(ownerToken))
        .send({ code: 'ERPBARCODE1', isPrimary: true })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/catalog/variants/${variantId}/barcodes`)
        .set('Authorization', bearer(ownerToken))
        .send({ code: 'ERPBARCODE1' })
        .expect(409);
    });
  });

  // ================================================================
  // 5. Deactivation — there is no delete
  // ================================================================
  describe('deactivation', () => {
    it('has NO delete route for a product or a variant', async () => {
      // `products.delete` exists as a permission code and is granted to
      // two role templates, but nothing consults it. The ERP therefore
      // offers deactivation and never invents delete semantics.
      await request(app.getHttpServer())
        .delete(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(ownerToken))
        .expect(404);

      await request(app.getHttpServer())
        .delete(`/api/v1/catalog/variants/${variantId}`)
        .set('Authorization', bearer(ownerToken))
        .expect(404);
    });

    it('deactivates a product WITHOUT losing it, and reactivates it', async () => {
      const off = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(ownerToken))
        .send({ status: 'INACTIVE' })
        .expect(200);
      expect(off.body.data.status).toBe('INACTIVE');

      // Still there, still readable, with its history intact.
      const still = await request(app.getHttpServer())
        .get(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(still.body.data.sku).toBe('ERP-CAT-1');

      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(ownerToken))
        .send({ status: 'ACTIVE' })
        .expect(200);
    });

    it('deactivates a VARIANT independently of its product', async () => {
      const extra = await request(app.getHttpServer())
        .post(`/api/v1/catalog/products/${productId}/variants`)
        .set('Authorization', bearer(ownerToken))
        .send({ sku: 'ERP-CAT-1-C' })
        .expect(201);

      const off = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${extra.body.data.id}`)
        .set('Authorization', bearer(ownerToken))
        .send({ status: 'INACTIVE' })
        .expect(200);
      expect(off.body.data.status).toBe('INACTIVE');

      const product = await request(app.getHttpServer())
        .get(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(product.body.data.status).toBe('ACTIVE');
    });
  });

  // ================================================================
  // 6. Bundles
  // ================================================================
  describe('bundle composition', () => {
    let bundleId: string;

    it('creates a BUNDLE, and refuses one with no components', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', bearer(ownerToken))
        .send({ sku: 'ERP-BUNDLE-EMPTY', name: 'Empty bundle', baseUomId: biz.uomId, type: 'BUNDLE' })
        .expect(422);

      const created = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', bearer(ownerToken))
        .send({
          sku: 'ERP-BUNDLE-1',
          name: 'Winter set',
          baseUomId: biz.uomId,
          type: 'BUNDLE',
          defaultSellingPrice: 1500,
          bundleItems: [{ variantId, quantity: 1 }],
        })
        .expect(201);
      bundleId = created.body.data.id;
      expect(created.body.data.type).toBe('BUNDLE');
    });

    it('REPLACES the whole composition through the existing PUT', async () => {
      const second = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', bearer(ownerToken))
        .send({ sku: 'ERP-SCARF', name: 'Scarf', baseUomId: biz.uomId, defaultSellingPrice: 200 })
        .expect(201);

      await request(app.getHttpServer())
        .put(`/api/v1/catalog/products/${bundleId}/bundle-items`)
        .set('Authorization', bearer(ownerToken))
        .send({ items: [{ variantId, quantity: 1 }, { variantId: second.body.data.variants[0].id, quantity: 2 }] })
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/catalog/products/${bundleId}`)
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(after.body.data.bundleItems).toHaveLength(2);
    });

    it('refuses composition on a SIMPLE product, and an empty list', async () => {
      // Both are why the ERP offers the editor only for a BUNDLE and
      // disables Save on an empty one.
      await request(app.getHttpServer())
        .put(`/api/v1/catalog/products/${productId}/bundle-items`)
        .set('Authorization', bearer(ownerToken))
        .send({ items: [{ variantId, quantity: 1 }] })
        .expect(422);

      await request(app.getHttpServer())
        .put(`/api/v1/catalog/products/${bundleId}/bundle-items`)
        .set('Authorization', bearer(ownerToken))
        .send({ items: [] })
        .expect(422);
    });

    it('refuses a bundle that would contain itself', async () => {
      const ownVariant = await admin.productVariant.findFirstOrThrow({ where: { productId: bundleId } });
      await request(app.getHttpServer())
        .put(`/api/v1/catalog/products/${bundleId}/bundle-items`)
        .set('Authorization', bearer(ownerToken))
        .send({ items: [{ variantId: ownVariant.id, quantity: 1 }] })
        .expect(422);
    });

    it('is invisible across a tenant boundary', async () => {
      await request(app.getHttpServer())
        .put(`/api/v1/catalog/products/${bundleId}/bundle-items`)
        .set('Authorization', bearer(other.accessToken))
        .send({ items: [{ variantId, quantity: 1 }] })
        .expect(404);
    });
  });

  // ================================================================
  // 7. Tax assignment
  // ================================================================
  describe('tax assignment', () => {
    it('records WHICH tax a product carries, and an explicit exemption', async () => {
      const tax = await request(app.getHttpServer())
        .post('/api/v1/taxes')
        .set('Authorization', bearer(ownerToken))
        .send({ name: 'VAT 14', ratePercent: 14 })
        .expect(201);

      const assigned = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(ownerToken))
        .send({ taxId: tax.body.data.id })
        .expect(200);
      expect(assigned.body.data.taxId).toBe(tax.body.data.id);

      // Exemption is EXPLICIT and never inferred from a missing tax —
      // omitting one means the business default applies.
      const exempt = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(ownerToken))
        .send({ taxId: null, taxExempt: true })
        .expect(200);
      expect(exempt.body.data.taxExempt).toBe(true);
      expect(exempt.body.data.taxId).toBeNull();

      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(ownerToken))
        .send({ taxExempt: false })
        .expect(200);
    });
  });

  // ================================================================
  // 8. Price lists — and the state the ERP warns about
  // ================================================================
  describe('price lists', () => {
    it('creates a list and holds the tenant to at most ONE default', async () => {
      const first = await request(app.getHttpServer())
        .post('/api/v1/catalog/price-lists')
        .set('Authorization', bearer(ownerToken))
        .send({ name: 'Retail', isDefault: true })
        .expect(201);
      priceListId = first.body.data.id;

      await request(app.getHttpServer())
        .post('/api/v1/catalog/price-lists')
        .set('Authorization', bearer(ownerToken))
        .send({ name: 'Wholesale', isDefault: true })
        .expect(201);

      const defaults = await admin.priceList.findMany({ where: { businessId: biz.businessId, isDefault: true } });
      expect(defaults).toHaveLength(1);
      expect(defaults[0].name).toBe('Wholesale');

      // Put Retail back in force for the pricing proof below.
      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/price-lists/${priceListId}`)
        .set('Authorization', bearer(ownerToken))
        .send({ isDefault: true })
        .expect(200);
    });

    it('carries exactly two applicability signals and nothing else', async () => {
      // The whole basis for `lib/priceLists.ts`. There is no customer-,
      // branch- or warehouse-scoped price list in the live model, and this
      // milestone does not invent one.
      const res = await request(app.getHttpServer())
        .get('/api/v1/catalog/price-lists')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      const list = res.body.data.find((l: { id: string }) => l.id === priceListId);
      expect(list).toEqual(expect.objectContaining({ isDefault: true, isActive: true }));
      for (const key of ['customerId', 'branchId', 'warehouseId', 'customerGroupId']) {
        expect(list).not.toHaveProperty(key);
      }
    });

    it('refuses a duplicate name', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/catalog/price-lists')
        .set('Authorization', bearer(ownerToken))
        .send({ name: 'Retail' })
        .expect(409);
    });

    it('separates `pricelists.edit` from `pricelists.manage_prices`', async () => {
      // Renaming a list and repricing the shop are different acts, so the
      // ERP puts them behind different controls.
      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/price-lists/${priceListId}`)
        .set('Authorization', bearer(merchandiserToken))
        .send({ name: 'Renamed by merchandiser' })
        .expect(403);

      await request(app.getHttpServer())
        .put(`/api/v1/catalog/price-lists/${priceListId}/prices`)
        .set('Authorization', bearer(merchandiserToken))
        .send({ variantId, price: 999 })
        .expect(200);
    });
  });

  // ================================================================
  // 9. BACKEND PRICING AUTHORITY — the proof that matters
  // ================================================================
  describe('backend pricing authority', () => {
    it('ERP configuration decides what the POS CHARGES, not the browser', async () => {
      // A till user who may NOT override prices.
      const tillToken = await userOnCustomRole('TILL', 'till', [
        'sales.create',
        'sales.view',
        'products.view',
        'shifts.view',
        'shifts.open',
        'shifts.close',
      ]);
      const registers = await request(app.getHttpServer())
        .get('/api/v1/cash-registers')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      // The fixture's owner already holds the only shift on that register.
      const register = registers.body.data[0];
      await request(app.getHttpServer())
        .post('/api/v1/sales/shifts/close')
        .set('Authorization', bearer(ownerToken))
        .send({ countedCash: 0 })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/sales/shifts/open')
        .set('Authorization', bearer(tillToken))
        .send({ warehouseId: biz.warehouseId, cashRegisterId: register.id, openingFloat: 0 })
        .expect(201);

      // The ERP writes a price into the ACTIVE DEFAULT list.
      await request(app.getHttpServer())
        .put(`/api/v1/catalog/price-lists/${priceListId}/prices`)
        .set('Authorization', bearer(ownerToken))
        .send({ variantId, price: 777 })
        .expect(200);

      // The till asks to sell at a different figure entirely.
      const quote = await request(app.getHttpServer())
        .post('/api/v1/sales/quote')
        .set('Authorization', bearer(tillToken))
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 5 }] })
        .expect(200);
      // The SERVER's figure, not the browser's.
      expect(Number(quote.body.data.lines[0].unitPrice)).toBe(777);

      const sale = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', bearer(tillToken))
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId, quantity: 1, unitPrice: 5 }],
          payments: [{ amount: 777, method: 'CASH' }],
        })
        .expect(201);
      expect(Number(sale.body.data.items[0].unitPrice)).toBe(777);

      // Changing the ERP price changes the NEXT sale...
      await request(app.getHttpServer())
        .put(`/api/v1/catalog/price-lists/${priceListId}/prices`)
        .set('Authorization', bearer(ownerToken))
        .send({ variantId, price: 888 })
        .expect(200);
      const after = await request(app.getHttpServer())
        .post('/api/v1/sales/quote')
        .set('Authorization', bearer(tillToken))
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 5 }] })
        .expect(200);
      expect(Number(after.body.data.lines[0].unitPrice)).toBe(888);

      // ...and REWRITES NOTHING already sold. Every sale kept the figure
      // it was written at, which is why editing a price list is safe.
      const stored = await admin.saleItem.findFirstOrThrow({ where: { saleId: sale.body.data.id } });
      expect(Number(stored.unitPrice)).toBe(777);
    });

    it('a DEACTIVATED default list stops applying — the state the ERP warns about', async () => {
      // The screen calls this "Default but inactive" and says every sale
      // then charges the price the till sends. This is that claim.
      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/price-lists/${priceListId}`)
        .set('Authorization', bearer(ownerToken))
        .send({ isActive: false })
        .expect(200);

      const tillToken = await login(`till@${biz.slug}.test`);
      const quote = await request(app.getHttpServer())
        .post('/api/v1/sales/quote')
        .set('Authorization', bearer(tillToken))
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 1, unitPrice: 5 }] })
        .expect(200);
      expect(Number(quote.body.data.lines[0].unitPrice)).toBe(5);

      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/price-lists/${priceListId}`)
        .set('Authorization', bearer(ownerToken))
        .send({ isActive: true })
        .expect(200);
    });
  });

  // ================================================================
  // 10. Tenant isolation
  // ================================================================
  describe('tenant isolation', () => {
    it('another tenant can neither read nor write this catalogue', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(other.accessToken))
        .expect(404);

      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(other.accessToken))
        .send({ name: 'Stolen' })
        .expect(404);

      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${variantId}/price`)
        .set('Authorization', bearer(other.accessToken))
        .send({ sellingPrice: 1 })
        .expect(404);

      const list = await request(app.getHttpServer())
        .get('/api/v1/catalog/products')
        .set('Authorization', bearer(other.accessToken))
        .expect(200);
      expect(list.body.data.map((p: { id: string }) => p.id)).not.toContain(productId);
    });

    it('another tenant can neither read nor write these PRICES', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/catalog/price-lists/${priceListId}/prices`)
        .set('Authorization', bearer(other.accessToken))
        .expect(404);

      await request(app.getHttpServer())
        .put(`/api/v1/catalog/price-lists/${priceListId}/prices`)
        .set('Authorization', bearer(other.accessToken))
        .send({ variantId, price: 1 })
        .expect(404);

      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/price-lists/${priceListId}`)
        .set('Authorization', bearer(other.accessToken))
        .send({ isDefault: true })
        .expect(404);

      const lists = await request(app.getHttpServer())
        .get('/api/v1/catalog/price-lists')
        .set('Authorization', bearer(other.accessToken))
        .expect(200);
      expect(lists.body.data.map((l: { id: string }) => l.id)).not.toContain(priceListId);

      // And this tenant's price is untouched by all of it.
      const price = await admin.productPrice.findFirstOrThrow({ where: { priceListId, variantId } });
      expect(Number(price.price)).toBe(888);
    });

    it('reference data does not leak across tenants either', async () => {
      const mine = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Authorization', bearer(ownerToken))
        .send({ name: 'Outerwear' })
        .expect(201);

      const theirs = await request(app.getHttpServer())
        .get('/api/v1/catalog/categories')
        .set('Authorization', bearer(other.accessToken))
        .expect(200);
      expect(theirs.body.data.map((c: { id: string }) => c.id)).not.toContain(mine.body.data.id);

      // A product cannot be filed under another tenant's category.
      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', bearer(ownerToken))
        .send({ categoryId: '00000000-0000-4000-8000-000000000000' })
        .expect(404);
    });
  });

  // ================================================================
  // 11. Reference data — generic, not clothing
  // ================================================================
  describe('reference data', () => {
    it('lets a TENANT define its own dimensions, whatever it sells', async () => {
      // The proof that this is a retail OS and not a clothing product:
      // the same endpoints carry a garment's vocabulary and an
      // appliance's, because neither is in the model.
      for (const [attribute, values] of [
        ['Size', ['Large', 'Medium']],
        ['Voltage', ['220V', '110V']],
      ] as const) {
        const attr = await request(app.getHttpServer())
          .post('/api/v1/catalog/attributes')
          .set('Authorization', bearer(ownerToken))
          .send({ name: attribute })
          .expect(201);
        for (const value of values) {
          await request(app.getHttpServer())
            .post(`/api/v1/catalog/attributes/${attr.body.data.id}/values`)
            .set('Authorization', bearer(ownerToken))
            .send({ value })
            .expect(201);
        }
      }

      const all = await request(app.getHttpServer())
        .get('/api/v1/catalog/attributes')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(all.body.data.map((a: { name: string }) => a.name)).toEqual(expect.arrayContaining(['Size', 'Voltage']));
    });

    it('deactivates a brand rather than deleting it', async () => {
      const brand = await request(app.getHttpServer())
        .post('/api/v1/catalog/brands')
        .set('Authorization', bearer(ownerToken))
        .send({ name: 'House Label' })
        .expect(201);

      const off = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/brands/${brand.body.data.id}`)
        .set('Authorization', bearer(ownerToken))
        .send({ isActive: false })
        .expect(200);
      expect(off.body.data.isActive).toBe(false);

      const still = await request(app.getHttpServer())
        .get('/api/v1/catalog/brands')
        .set('Authorization', bearer(ownerToken))
        .expect(200);
      expect(still.body.data.map((b: { id: string }) => b.id)).toContain(brand.body.data.id);
    });
  });
});
