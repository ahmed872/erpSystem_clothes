import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { registerAndLogin, RegisteredBusiness } from './utils/register-and-login';

describe('Catalog: Categories / Brands / UOMs / Attributes (e2e, real Postgres)', () => {
  let app: INestApplication;
  let biz: RegisteredBusiness;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    biz = await registerAndLogin(app, 'refdata');
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  describe('Categories', () => {
    it('creates a top-level category and a subcategory under it', async () => {
      const top = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Authorization', auth())
        .send({ name: 'Clothing' })
        .expect(201);

      const sub = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Authorization', auth())
        .send({ name: 'Shirts', parentId: top.body.data.id })
        .expect(201);
      expect(sub.body.data.parentId).toBe(top.body.data.id);
    });

    it('rejects two top-level categories with the same name (partial unique index)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Authorization', auth())
        .send({ name: 'Electronics' })
        .expect(201);
      const dup = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Authorization', auth())
        .send({ name: 'Electronics' })
        .expect(409);
      expect(dup.body.error.code).toBe('CONFLICT');
    });

    it('allows the same name at two different levels (different parent)', async () => {
      const parentA = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Authorization', auth())
        .send({ name: 'ParentA' })
        .expect(201);
      const parentB = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Authorization', auth())
        .send({ name: 'ParentB' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Authorization', auth())
        .send({ name: 'Accessories', parentId: parentA.body.data.id })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Authorization', auth())
        .send({ name: 'Accessories', parentId: parentB.body.data.id })
        .expect(201);
    });

    it('rejects making a category its own parent, or a descendant its ancestor (cycle guard)', async () => {
      const root = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Authorization', auth())
        .send({ name: 'CycleRoot' })
        .expect(201);
      const child = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Authorization', auth())
        .send({ name: 'CycleChild', parentId: root.body.data.id })
        .expect(201);

      const selfParent = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/categories/${root.body.data.id}`)
        .set('Authorization', auth())
        .send({ parentId: root.body.data.id })
        .expect(422);
      expect(selfParent.body.error.code).toBe('VALIDATION_FAILED');

      // root cannot become a child of its own child
      const cycle = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/categories/${root.body.data.id}`)
        .set('Authorization', auth())
        .send({ parentId: child.body.data.id })
        .expect(422);
      expect(cycle.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('404s when parentId references a category from another tenant', async () => {
      const other = await registerAndLogin(app, 'refdata-other');
      const otherCategory = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ name: 'OtherTenantCategory' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Authorization', auth())
        .send({ name: 'ShouldFail', parentId: otherCategory.body.data.id })
        .expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Brands', () => {
    it('creates and lists brands, rejects duplicates', async () => {
      await request(app.getHttpServer()).post('/api/v1/catalog/brands').set('Authorization', auth()).send({ name: 'Nike' }).expect(201);
      const dup = await request(app.getHttpServer())
        .post('/api/v1/catalog/brands')
        .set('Authorization', auth())
        .send({ name: 'Nike' })
        .expect(409);
      expect(dup.body.error.code).toBe('CONFLICT');

      const list = await request(app.getHttpServer()).get('/api/v1/catalog/brands').set('Authorization', auth()).expect(200);
      expect(list.body.data.some((b: { name: string }) => b.name === 'Nike')).toBe(true);
    });

    it('deactivates a brand via update (soft, not hard delete)', async () => {
      const brand = await request(app.getHttpServer())
        .post('/api/v1/catalog/brands')
        .set('Authorization', auth())
        .send({ name: 'Adidas' })
        .expect(201);
      const updated = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/brands/${brand.body.data.id}`)
        .set('Authorization', auth())
        .send({ isActive: false })
        .expect(200);
      expect(updated.body.data.isActive).toBe(false);
    });
  });

  describe('Units of Measure', () => {
    it('creates a UOM with precision, rejects duplicate name or code', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/catalog/uoms')
        .set('Authorization', auth())
        .send({ name: 'Kilogram', code: 'KG', precision: 3 })
        .expect(201);

      const dupName = await request(app.getHttpServer())
        .post('/api/v1/catalog/uoms')
        .set('Authorization', auth())
        .send({ name: 'Kilogram', code: 'KG2' })
        .expect(409);
      expect(dupName.body.error.code).toBe('CONFLICT');

      const dupCode = await request(app.getHttpServer())
        .post('/api/v1/catalog/uoms')
        .set('Authorization', auth())
        .send({ name: 'Kilogram2', code: 'KG' })
        .expect(409);
      expect(dupCode.body.error.code).toBe('CONFLICT');
    });

    it('rejects an invalid precision (out of 0-6 range)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/catalog/uoms')
        .set('Authorization', auth())
        .send({ name: 'Weird', code: 'WRD', precision: 12 })
        .expect(422);
    });

    it('lowercases-to-uppercase-normalizes the unit code', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/catalog/uoms')
        .set('Authorization', auth())
        .send({ name: 'Liter', code: 'ltr' })
        .expect(201);
      expect(res.body.data.code).toBe('LTR');
    });
  });

  describe('Attributes & values', () => {
    it('creates an attribute with values and rejects duplicate values', async () => {
      const attr = await request(app.getHttpServer())
        .post('/api/v1/catalog/attributes')
        .set('Authorization', auth())
        .send({ name: 'Size' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/catalog/attributes/${attr.body.data.id}/values`)
        .set('Authorization', auth())
        .send({ value: 'Small' })
        .expect(201);

      const dup = await request(app.getHttpServer())
        .post(`/api/v1/catalog/attributes/${attr.body.data.id}/values`)
        .set('Authorization', auth())
        .send({ value: 'Small' })
        .expect(409);
      expect(dup.body.error.code).toBe('CONFLICT');

      const list = await request(app.getHttpServer()).get('/api/v1/catalog/attributes').set('Authorization', auth()).expect(200);
      const sizeAttr = list.body.data.find((a: { id: string }) => a.id === attr.body.data.id);
      expect(sizeAttr.values.map((v: { value: string }) => v.value)).toContain('Small');
    });

    it('deletes an unused attribute value but blocks deleting one still used by a variant', async () => {
      const attr = await request(app.getHttpServer())
        .post('/api/v1/catalog/attributes')
        .set('Authorization', auth())
        .send({ name: 'Material' })
        .expect(201);
      const value = await request(app.getHttpServer())
        .post(`/api/v1/catalog/attributes/${attr.body.data.id}/values`)
        .set('Authorization', auth())
        .send({ value: 'Cotton' })
        .expect(201);

      // Unused - deletable.
      await request(app.getHttpServer())
        .delete(`/api/v1/catalog/attribute-values/${value.body.data.id}`)
        .set('Authorization', auth())
        .expect(200);

      // Recreate and attach to a variant, then confirm it's blocked.
      const value2 = await request(app.getHttpServer())
        .post(`/api/v1/catalog/attributes/${attr.body.data.id}/values`)
        .set('Authorization', auth())
        .send({ value: 'Polyester' })
        .expect(201);

      const uom = await request(app.getHttpServer())
        .post('/api/v1/catalog/uoms')
        .set('Authorization', auth())
        .send({ name: 'AttrTestUnit', code: 'ATU' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', auth())
        .send({
          sku: 'ATTR-TEST-PRODUCT',
          name: 'Attr Test Product',
          baseUomId: uom.body.data.id,
          variants: [{ sku: 'ATTR-TEST-VARIANT', attributeValueIds: [value2.body.data.id] }],
        })
        .expect(201);

      const blocked = await request(app.getHttpServer())
        .delete(`/api/v1/catalog/attribute-values/${value2.body.data.id}`)
        .set('Authorization', auth())
        .expect(409);
      expect(blocked.body.error.code).toBe('CONFLICT');
    });
  });
});
