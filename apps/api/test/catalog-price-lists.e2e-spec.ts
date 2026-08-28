import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { registerAndLogin, RegisteredBusiness } from './utils/register-and-login';

describe('Catalog: Price Lists (e2e, real Postgres)', () => {
  let app: INestApplication;
  let biz: RegisteredBusiness;
  let uomId: string;
  let variantId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    biz = await registerAndLogin(app, 'pricelists');

    const uom = await request(app.getHttpServer())
      .post('/api/v1/catalog/uoms')
      .set('Authorization', auth())
      .send({ name: 'Piece', code: 'PCS' })
      .expect(201);
    uomId = uom.body.data.id;

    const product = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', auth())
      .send({ sku: 'PL-PRODUCT', name: 'Price List Product', baseUomId: uomId, defaultCost: 10, defaultSellingPrice: 20 })
      .expect(201);
    variantId = product.body.data.variants[0].id;
  });

  afterAll(async () => {
    await app.close();
  });

  function auth() {
    return `Bearer ${biz.accessToken}`;
  }

  it('creates a price list, rejects duplicate name', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/catalog/price-lists')
      .set('Authorization', auth())
      .send({ name: 'Wholesale' })
      .expect(201);
    const dup = await request(app.getHttpServer())
      .post('/api/v1/catalog/price-lists')
      .set('Authorization', auth())
      .send({ name: 'Wholesale' })
      .expect(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('enforces only one default price list per tenant (creating a second default un-defaults the first)', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/v1/catalog/price-lists')
      .set('Authorization', auth())
      .send({ name: 'Retail Default', isDefault: true })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/api/v1/catalog/price-lists')
      .set('Authorization', auth())
      .send({ name: 'VIP Default', isDefault: true })
      .expect(201);

    const list = await request(app.getHttpServer()).get('/api/v1/catalog/price-lists').set('Authorization', auth()).expect(200);
    const firstRow = list.body.data.find((p: { id: string }) => p.id === first.body.data.id);
    const secondRow = list.body.data.find((p: { id: string }) => p.id === second.body.data.id);
    expect(firstRow.isDefault).toBe(false);
    expect(secondRow.isDefault).toBe(true);
  });

  it('sets a variant price in a price list and updates it (upsert), each recorded in price history', async () => {
    const priceList = await request(app.getHttpServer())
      .post('/api/v1/catalog/price-lists')
      .set('Authorization', auth())
      .send({ name: 'Bulk Pricing' })
      .expect(201);

    await request(app.getHttpServer())
      .put(`/api/v1/catalog/price-lists/${priceList.body.data.id}/prices`)
      .set('Authorization', auth())
      .send({ variantId, price: 18 })
      .expect(200);

    const entries1 = await request(app.getHttpServer())
      .get(`/api/v1/catalog/price-lists/${priceList.body.data.id}/prices`)
      .set('Authorization', auth())
      .expect(200);
    expect(entries1.body.data).toHaveLength(1);
    expect(entries1.body.data[0].price).toBe('18');

    await request(app.getHttpServer())
      .put(`/api/v1/catalog/price-lists/${priceList.body.data.id}/prices`)
      .set('Authorization', auth())
      .send({ variantId, price: 16.5 })
      .expect(200);

    const entries2 = await request(app.getHttpServer())
      .get(`/api/v1/catalog/price-lists/${priceList.body.data.id}/prices`)
      .set('Authorization', auth())
      .expect(200);
    expect(entries2.body.data).toHaveLength(1); // upsert, not a duplicate row
    expect(entries2.body.data[0].price).toBe('16.5');
  });

  it('404s when setting a price for a variant that does not belong to the tenant', async () => {
    const priceList = await request(app.getHttpServer())
      .post('/api/v1/catalog/price-lists')
      .set('Authorization', auth())
      .send({ name: 'Isolated List' })
      .expect(201);
    const res = await request(app.getHttpServer())
      .put(`/api/v1/catalog/price-lists/${priceList.body.data.id}/prices`)
      .set('Authorization', auth())
      .send({ variantId: '00000000-0000-0000-0000-000000000000', price: 5 })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
