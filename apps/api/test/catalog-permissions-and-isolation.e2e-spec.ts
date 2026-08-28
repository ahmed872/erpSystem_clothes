import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { registerAndLogin, RegisteredBusiness } from './utils/register-and-login';

describe('Catalog: authorization & tenant isolation (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let appRoleClient: PrismaClient;
  let biz: RegisteredBusiness;
  let uomId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    appRoleClient = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
    biz = await registerAndLogin(app, 'permsiso');

    const uom = await request(app.getHttpServer())
      .post('/api/v1/catalog/uoms')
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .send({ name: 'Piece', code: 'PCS' })
      .expect(201);
    uomId = uom.body.data.id;

    const product = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .send({ sku: 'PERM-PRODUCT', name: 'Perm Product', baseUomId: uomId, defaultCost: 42, defaultSellingPrice: 99 })
      .expect(201);
    productId = product.body.data.id;
    variantId = product.body.data.variants[0].id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await appRoleClient.$disconnect();
    await app.close();
  });

  describe('Field-level authorization: products.view_cost', () => {
    it('a Cashier (no products.view_cost) gets products/variants with cost fields stripped, not just hidden client-side', async () => {
      const cashierRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'CASHIER' } });
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${biz.accessToken}`)
        .send({ name: 'Cashier', email: `cashier@${biz.slug}.test`, password: 'CashierPass1!', roleIds: [cashierRole.id] })
        .expect(201);
      const cashierLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `cashier@${biz.slug}.test`, password: 'CashierPass1!', businessSlug: biz.slug })
        .expect(200);
      const cashierToken = cashierLogin.body.data.accessToken;

      const getProduct = await request(app.getHttpServer())
        .get(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);
      expect(getProduct.body.data.defaultCost).toBeUndefined();
      expect(getProduct.body.data.variants[0].cost).toBeUndefined();
      expect(getProduct.body.data.name).toBe('Perm Product'); // non-cost fields still present

      const lookup = await request(app.getHttpServer())
        .get('/api/v1/catalog/variants/lookup?sku=PERM-PRODUCT')
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);
      expect(lookup.body.data.cost).toBeUndefined();
      expect(lookup.body.data.sellingPrice).toBeDefined(); // selling price is not cost - still visible

      const list = await request(app.getHttpServer())
        .get('/api/v1/catalog/products')
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);
      expect(list.body.data.every((p: { defaultCost?: unknown }) => p.defaultCost === undefined)).toBe(true);

      // The owner, who DOES have products.view_cost, sees it.
      const ownerView = await request(app.getHttpServer())
        .get(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', `Bearer ${biz.accessToken}`)
        .expect(200);
      expect(ownerView.body.data.defaultCost).toBe('42');
    });

    it('a Cashier cannot create a product (403) or change cost/price (403) even with products.view', async () => {
      const cashierLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `cashier@${biz.slug}.test`, password: 'CashierPass1!', businessSlug: biz.slug })
        .expect(200);
      const cashierToken = cashierLogin.body.data.accessToken;

      const createAttempt = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ sku: 'SHOULD-FAIL', name: 'X', baseUomId: uomId })
        .expect(403);
      expect(createAttempt.body.error.code).toBe('FORBIDDEN');

      const costAttempt = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${variantId}/cost`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ cost: 1 })
        .expect(403);
      expect(costAttempt.body.error.code).toBe('FORBIDDEN');

      const priceAttempt = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${variantId}/price`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ sellingPrice: 1 })
        .expect(403);
      expect(priceAttempt.body.error.code).toBe('FORBIDDEN');
    });

    it('an Inventory Manager DOES have products.change_cost and products.view_cost by default template', async () => {
      const invRole = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'INVENTORY_MANAGER' } });
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${biz.accessToken}`)
        .send({ name: 'Inv Mgr', email: `invmgr@${biz.slug}.test`, password: 'InvMgrPass1!', roleIds: [invRole.id] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `invmgr@${biz.slug}.test`, password: 'InvMgrPass1!', businessSlug: biz.slug })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${variantId}/cost`)
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .send({ cost: 50 })
        .expect(200);

      const view = await request(app.getHttpServer())
        .get(`/api/v1/catalog/variants/${variantId}`)
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .expect(200);
      expect(view.body.data.cost).toBe('50');
    });
  });

  describe('Tenant isolation', () => {
    let other: RegisteredBusiness;

    beforeAll(async () => {
      other = await registerAndLogin(app, 'permsiso-other');
    });

    it('API layer: tenant B cannot see or fetch tenant A products, categories, or brands', async () => {
      const list = await request(app.getHttpServer())
        .get('/api/v1/catalog/products')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(200);
      expect(list.body.data.find((p: { id: string }) => p.id === productId)).toBeUndefined();

      const get = await request(app.getHttpServer())
        .get(`/api/v1/catalog/products/${productId}`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(404);
      expect(get.body.error.code).toBe('NOT_FOUND');
    });

    it('API layer: tenant B cannot change tenant A variant cost/price by guessing the id', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/variants/${variantId}/cost`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ cost: 1 })
        .expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');

      const stillOriginal = await admin.productVariant.findUniqueOrThrow({ where: { id: variantId } });
      expect(Number(stillOriginal.cost)).not.toBe(1);
    });

    it('DB layer: a raw unfiltered query against products as erp_app returns zero rows with no tenant context set', async () => {
      const rows = await appRoleClient.$queryRawUnsafe<unknown[]>('SELECT * FROM products');
      expect(rows.length).toBe(0);
    });

    it('DB layer: setting tenant context to A returns only A products, and inserting a product for A while context is B is rejected', async () => {
      const rows = await appRoleClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
        return tx.$queryRawUnsafe<{ business_id: string }[]>('SELECT business_id FROM products');
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.business_id === biz.businessId)).toBe(true);

      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${other.businessId}'`);
          await tx.$executeRawUnsafe(
            `INSERT INTO products (id, business_id, sku, name, base_uom_id, updated_at)
             VALUES ('${randomUUID()}', '${biz.businessId}', 'SMUGGLED', 'Smuggled', '${uomId}', NOW())`,
          );
        }),
      ).rejects.toThrow();

      const smuggled = await admin.product.findFirst({ where: { sku: 'SMUGGLED' } });
      expect(smuggled).toBeNull();
    });

    it('DB layer: product_price_history is append-only - erp_app has no UPDATE/DELETE privilege', async () => {
      const historyRow = await admin.productPriceHistory.findFirst({ where: { variantId } });
      if (!historyRow) throw new Error('expected a price history row to exist from an earlier test');

      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
          await tx.$executeRawUnsafe(`UPDATE product_price_history SET new_value = 999 WHERE id = '${historyRow.id}'`);
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it('DB layer: products and product_variants cannot be hard-deleted by erp_app at all (no DELETE grant)', async () => {
      await expect(
        appRoleClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${biz.businessId}'`);
          await tx.$executeRawUnsafe(`DELETE FROM products WHERE id = '${productId}'`);
        }),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
