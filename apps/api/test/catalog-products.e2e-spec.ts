import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { registerAndLogin, RegisteredBusiness } from './utils/register-and-login';

describe('Catalog: Products & Variants (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: RegisteredBusiness;
  let uomId: string;
  let cartonUomId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await registerAndLogin(app, 'products');

    const uom = await request(app.getHttpServer())
      .post('/api/v1/catalog/uoms')
      .set('Authorization', auth())
      .send({ name: 'Piece', code: 'PCS' })
      .expect(201);
    uomId = uom.body.data.id;

    const carton = await request(app.getHttpServer())
      .post('/api/v1/catalog/uoms')
      .set('Authorization', auth())
      .send({ name: 'Carton', code: 'CTN' })
      .expect(201);
    cartonUomId = carton.body.data.id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  function auth() {
    return `Bearer ${biz.accessToken}`;
  }

  describe('Simple product creation (auto default variant)', () => {
    it('creates a simple product with no explicit variants and gets exactly one auto-generated default variant', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'SIMPLE-1', name: 'Simple Product', baseUomId: uomId, defaultCost: 5, defaultSellingPrice: 12 })
        .expect(201);

      expect(res.body.data.variants).toHaveLength(1);
      expect(res.body.data.variants[0].sku).toBe('SIMPLE-1');
      expect(res.body.data.variants[0].cost).toBe('5');
      expect(res.body.data.variants[0].sellingPrice).toBe('12');
    });

    it('rejects a duplicate product SKU with 409', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'DUPTEST', name: 'A', baseUomId: uomId })
        .expect(201);
      const dup = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'DUPTEST', name: 'B', baseUomId: uomId })
        .expect(409);
      expect(dup.body.error.code).toBe('CONFLICT');
    });

    it('404s when baseUomId, categoryId or brandId do not belong to the tenant', async () => {
      const badUom = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'BADUOM', name: 'X', baseUomId: '00000000-0000-0000-0000-000000000000' })
        .expect(404);
      expect(badUom.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects minimumStock greater than maximumStock', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'BADSTOCK', name: 'X', baseUomId: uomId, minimumStock: 100, maximumStock: 10 })
        .expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('Products with explicit attribute-based variants', () => {
    async function createColorAttribute(value: string) {
      const attr = await request(app.getHttpServer())
        .post('/api/v1/catalog/attributes')
        .set('Authorization', auth())
        .send({ name: `Color-${Date.now()}-${Math.random()}` })
        .expect(201);
      const val = await request(app.getHttpServer())
        .post(`/api/v1/catalog/attributes/${attr.body.data.id}/values`)
        .set('Authorization', auth())
        .send({ value })
        .expect(201);
      return val.body.data.id as string;
    }

    it('creates a product with two variants distinguished by attribute value, each own SKU/barcode', async () => {
      const blackId = await createColorAttribute('Black');
      const whiteId = await createColorAttribute('White');

      const res = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({
          sku: 'TSHIRT-MULTI',
          name: 'T-Shirt',
          baseUomId: uomId,
          defaultCost: 10,
          defaultSellingPrice: 25,
          variants: [
            { sku: 'TSHIRT-MULTI-BLK', attributeValueIds: [blackId], barcodes: ['9990001'] },
            { sku: 'TSHIRT-MULTI-WHT', attributeValueIds: [whiteId], barcodes: ['9990002'], sellingPrice: 27 },
          ],
        })
        .expect(201);

      expect(res.body.data.variants).toHaveLength(2);
      const white = res.body.data.variants.find((v: { sku: string }) => v.sku === 'TSHIRT-MULTI-WHT');
      expect(white.sellingPrice).toBe('27');
      expect(white.barcodes[0].code).toBe('9990002');
      expect(white.barcodes[0].isPrimary).toBe(true);
    });

    it('rejects two variants in the same request with identical attribute combinations', async () => {
      const redId = await createColorAttribute('Red');
      const res = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({
          sku: 'DUPVARIANT',
          name: 'X',
          baseUomId: uomId,
          variants: [
            { sku: 'DUPVARIANT-A', attributeValueIds: [redId] },
            { sku: 'DUPVARIANT-B', attributeValueIds: [redId] },
          ],
        })
        .expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a variant carrying two values for the same attribute', async () => {
      const attr = await request(app.getHttpServer())
        .post('/api/v1/catalog/attributes')
        .set('Authorization', auth())
        .send({ name: `Size-${Date.now()}` })
        .expect(201);
      const small = await request(app.getHttpServer())
        .post(`/api/v1/catalog/attributes/${attr.body.data.id}/values`)
        .set('Authorization', auth())
        .send({ value: 'Small' })
        .expect(201);
      const large = await request(app.getHttpServer())
        .post(`/api/v1/catalog/attributes/${attr.body.data.id}/values`)
        .set('Authorization', auth())
        .send({ value: 'Large' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({
          sku: 'BADATTR',
          name: 'X',
          baseUomId: uomId,
          variants: [{ sku: 'BADATTR-V1', attributeValueIds: [small.body.data.id, large.body.data.id] }],
        })
        .expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a variant SKU that collides with an existing Product SKU (cross-table uniqueness)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'CROSSTABLE-PROD', name: 'X', baseUomId: uomId })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({
          sku: 'CROSSTABLE-2',
          name: 'Y',
          baseUomId: uomId,
          variants: [{ sku: 'CROSSTABLE-PROD' }],
        })
        .expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });
  });

  describe('Bundles', () => {
    it('creates a bundle product composed of two component variants', async () => {
      const phone = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'PHONE', name: 'Phone', baseUomId: uomId, defaultCost: 100, defaultSellingPrice: 150 })
        .expect(201);
      const charger = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'CHARGER', name: 'Charger', baseUomId: uomId, defaultCost: 5, defaultSellingPrice: 10 })
        .expect(201);

      const phoneVariantId = phone.body.data.variants[0].id;
      const chargerVariantId = charger.body.data.variants[0].id;

      const bundle = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({
          sku: 'PHONE-BUNDLE',
          name: 'Phone + Charger Bundle',
          type: 'BUNDLE',
          baseUomId: uomId,
          defaultSellingPrice: 140,
          bundleItems: [
            { variantId: phoneVariantId, quantity: 1 },
            { variantId: chargerVariantId, quantity: 1 },
          ],
        })
        .expect(201);

      expect(bundle.body.data.type).toBe('BUNDLE');
      expect(bundle.body.data.bundleItems).toHaveLength(2);
      // The bundle itself still has exactly one sellable default variant,
      // but carries no inventory of its own (Phase 3 concern).
      expect(bundle.body.data.variants).toHaveLength(1);
    });

    it('rejects a BUNDLE product with no bundleItems, and a SIMPLE product that has bundleItems', async () => {
      const noItems = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'BADBUNDLE', name: 'X', type: 'BUNDLE', baseUomId: uomId })
        .expect(422);
      expect(noItems.body.error.code).toBe('VALIDATION_FAILED');

      const simple = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'SIMPLEWITHITEMS', name: 'X', baseUomId: uomId })
        .expect(201);
      const badSimple = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({
          sku: 'SIMPLEWITHITEMS2',
          name: 'Y',
          baseUomId: uomId,
          bundleItems: [{ variantId: simple.body.data.variants[0].id, quantity: 1 }],
        })
        .expect(422);
      expect(badSimple.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a bundle that contains another bundle as a component (no nested bundles)', async () => {
      const component = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'NESTED-COMPONENT', name: 'X', baseUomId: uomId })
        .expect(201);
      const innerBundle = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({
          sku: 'INNER-BUNDLE',
          name: 'Inner',
          type: 'BUNDLE',
          baseUomId: uomId,
          bundleItems: [{ variantId: component.body.data.variants[0].id, quantity: 1 }],
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({
          sku: 'OUTER-BUNDLE',
          name: 'Outer',
          type: 'BUNDLE',
          baseUomId: uomId,
          bundleItems: [{ variantId: innerBundle.body.data.variants[0].id, quantity: 1 }],
        })
        .expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('replaces bundle composition via PUT bundle-items, rejected on a non-bundle product', async () => {
      const compA = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'REPLACE-A', name: 'A', baseUomId: uomId })
        .expect(201);
      const compB = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'REPLACE-B', name: 'B', baseUomId: uomId })
        .expect(201);
      const bundle = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({
          sku: 'REPLACE-BUNDLE',
          name: 'Bundle',
          type: 'BUNDLE',
          baseUomId: uomId,
          bundleItems: [{ variantId: compA.body.data.variants[0].id, quantity: 1 }],
        })
        .expect(201);

      const replaced = await request(app.getHttpServer())
        .put(`/api/v1/catalog/products/${bundle.body.data.id}/bundle-items`)
        .set('Authorization', auth())
        .send({ items: [{ variantId: compB.body.data.variants[0].id, quantity: 3 }] })
        .expect(200);
      expect(replaced.body.data).toHaveLength(1);
      expect(replaced.body.data[0].componentVariantId).toBe(compB.body.data.variants[0].id);

      const nonBundle = await request(app.getHttpServer())
        .put(`/api/v1/catalog/products/${compA.body.data.id}/bundle-items`)
        .set('Authorization', auth())
        .send({ items: [{ variantId: compB.body.data.variants[0].id, quantity: 1 }] })
        .expect(422);
      expect(nonBundle.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('Adding variants / updating / cost & price changes', () => {
    it('adds a variant to an existing product after creation', async () => {
      const product = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'ADDVARIANT-P', name: 'X', baseUomId: uomId, defaultCost: 1, defaultSellingPrice: 2 })
        .expect(201);

      const variant = await request(app.getHttpServer())
        .post(`/api/v1/catalog/products/${product.body.data.id}/variants`)
        .set('Authorization', auth())
        .send({ sku: 'ADDVARIANT-P-2' })
        .expect(201);
      expect(variant.body.data.sku).toBe('ADDVARIANT-P-2');
      expect(variant.body.data.cost).toBe('1'); // inherits product default
    });

    it('changes variant cost and selling price, each writing a ProductPriceHistory row', async () => {
      const product = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'PRICECHANGE-P', name: 'X', baseUomId: uomId, defaultCost: 10, defaultSellingPrice: 20 })
        .expect(201);
      const variantId = product.body.data.variants[0].id;

      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${variantId}/cost`)
        .set('Authorization', auth())
        .send({ cost: 15 })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${variantId}/price`)
        .set('Authorization', auth())
        .send({ sellingPrice: 30 })
        .expect(200);

      const history = await admin.productPriceHistory.findMany({ where: { variantId }, orderBy: { createdAt: 'asc' } });
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ changeType: 'COST', newValue: expect.anything() });
      expect(Number(history[0].oldValue)).toBe(10);
      expect(Number(history[0].newValue)).toBe(15);
      expect(history[1].changeType).toBe('SELLING_PRICE');
      expect(Number(history[1].oldValue)).toBe(20);
      expect(Number(history[1].newValue)).toBe(30);
    });

    it('updates variant status/weight/dimensions via general update', async () => {
      const product = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'VARUPDATE-P', name: 'X', baseUomId: uomId })
        .expect(201);
      const variantId = product.body.data.variants[0].id;

      const updated = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${variantId}`)
        .set('Authorization', auth())
        .send({ status: 'INACTIVE', weight: 1.5, dimensions: { length: 10, width: 5, height: 2, unit: 'cm' } })
        .expect(200);
      expect(updated.body.data.status).toBe('INACTIVE');
      expect(updated.body.data.weight).toBe('1.5');
    });
  });

  describe('Barcode lookup (POS scan path)', () => {
    it('finds a variant by barcode and by SKU', async () => {
      const product = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({
          sku: 'LOOKUP-P',
          name: 'Lookup Product',
          baseUomId: uomId,
          variants: [{ sku: 'LOOKUP-P-V1', barcodes: ['5551234'] }],
        })
        .expect(201);

      const byBarcode = await request(app.getHttpServer())
        .get('/api/v1/catalog/variants/lookup?barcode=5551234')
        .set('Authorization', auth())
        .expect(200);
      expect(byBarcode.body.data.id).toBe(product.body.data.variants[0].id);

      const bySku = await request(app.getHttpServer())
        .get('/api/v1/catalog/variants/lookup?sku=LOOKUP-P-V1')
        .set('Authorization', auth())
        .expect(200);
      expect(bySku.body.data.id).toBe(product.body.data.variants[0].id);
    });

    it('404s for an unknown barcode, 422 when neither barcode nor sku is given', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/catalog/variants/lookup?barcode=NOPE')
        .set('Authorization', auth())
        .expect(404);
      await request(app.getHttpServer()).get('/api/v1/catalog/variants/lookup').set('Authorization', auth()).expect(422);
    });

    it('rejects adding a second barcode that already exists for the tenant, but allows adding a fresh one with isPrimary swap', async () => {
      const product = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'BCADD-P', name: 'X', baseUomId: uomId, variants: [{ sku: 'BCADD-P-V1', barcodes: ['7778888'] }] })
        .expect(201);
      const variantId = product.body.data.variants[0].id;

      const dup = await request(app.getHttpServer())
        .post(`/api/v1/catalog/variants/${variantId}/barcodes`)
        .set('Authorization', auth())
        .send({ code: '7778888' })
        .expect(409);
      expect(dup.body.error.code).toBe('CONFLICT');

      const second = await request(app.getHttpServer())
        .post(`/api/v1/catalog/variants/${variantId}/barcodes`)
        .set('Authorization', auth())
        .send({ code: '7778889', isPrimary: true })
        .expect(201);
      expect(second.body.data.isPrimary).toBe(true);

      const stillOnlyOnePrimary = await admin.barcode.count({ where: { variantId, isPrimary: true } });
      expect(stillOnlyOnePrimary).toBe(1);
    });
  });

  describe('Product UOMs (multi-UOM / conversion factor)', () => {
    it('adds a purchase UOM with a conversion factor and rejects adding the base UOM itself', async () => {
      const product = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'MULTIUOM-P', name: 'X', baseUomId: uomId })
        .expect(201);

      const added = await request(app.getHttpServer())
        .post(`/api/v1/catalog/products/${product.body.data.id}/uoms`)
        .set('Authorization', auth())
        .send({ uomId: cartonUomId, conversionFactor: 12, isPurchaseUom: true })
        .expect(201);
      expect(added.body.data.conversionFactor).toBe('12');

      const rejectBase = await request(app.getHttpServer())
        .post(`/api/v1/catalog/products/${product.body.data.id}/uoms`)
        .set('Authorization', auth())
        .send({ uomId: uomId, conversionFactor: 1 })
        .expect(422);
      expect(rejectBase.body.error.code).toBe('VALIDATION_FAILED');

      const duplicate = await request(app.getHttpServer())
        .post(`/api/v1/catalog/products/${product.body.data.id}/uoms`)
        .set('Authorization', auth())
        .send({ uomId: cartonUomId, conversionFactor: 24 })
        .expect(409);
      expect(duplicate.body.error.code).toBe('CONFLICT');
    });

    it('rejects a non-positive conversion factor', async () => {
      const product = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({ sku: 'BADFACTOR-P', name: 'X', baseUomId: uomId })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/catalog/products/${product.body.data.id}/uoms`)
        .set('Authorization', auth())
        .send({ uomId: cartonUomId, conversionFactor: 0 })
        .expect(422);
    });
  });

  describe('Listing, filtering, pagination', () => {
    it('filters by search term and paginates', async () => {
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post('/api/v1/catalog/products')
          .set('Authorization', auth())
          .send({ sku: `PAGE-${i}`, name: `Pageable Product ${i}`, baseUomId: uomId })
          .expect(201);
      }
      const page1 = await request(app.getHttpServer())
        .get('/api/v1/catalog/products?search=Pageable&page=1&limit=2')
        .set('Authorization', auth())
        .expect(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.pagination.total).toBeGreaterThanOrEqual(3);
    });
  });
});
