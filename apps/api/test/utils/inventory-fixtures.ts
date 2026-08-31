import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { registerAndLogin, RegisteredBusiness } from './register-and-login';

export interface InventoryFixture extends RegisteredBusiness {
  uomId: string;
  cartonUomId: string;
}

/** Registers a fresh business and creates the two UOMs (Piece + Carton)
 * most inventory e2e specs need. */
export async function setupInventoryFixture(app: INestApplication, slugSuffix: string): Promise<InventoryFixture> {
  const biz = await registerAndLogin(app, slugSuffix);
  const auth = `Bearer ${biz.accessToken}`;

  const uom = await request(app.getHttpServer())
    .post('/api/v1/catalog/uoms')
    .set('Authorization', auth)
    .send({ name: 'Piece', code: 'PCS' })
    .expect(201);
  const carton = await request(app.getHttpServer())
    .post('/api/v1/catalog/uoms')
    .set('Authorization', auth)
    .send({ name: 'Carton', code: 'CTN' })
    .expect(201);

  return { ...biz, uomId: uom.body.data.id, cartonUomId: carton.body.data.id };
}

export async function createSimpleProduct(
  app: INestApplication,
  token: string,
  uomId: string,
  sku: string,
  opts?: {
    defaultCost?: number;
    defaultSellingPrice?: number;
    tracksLots?: boolean;
    tracksSerialNumbers?: boolean;
    /** Phase 10 (BD-18): the product's own tax, and an explicit exemption. */
    taxId?: string;
    taxExempt?: boolean;
  },
): Promise<{ productId: string; variantId: string }> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/catalog/products')
    .set('Authorization', `Bearer ${token}`)
    .send({
      sku,
      name: sku,
      baseUomId: uomId,
      defaultCost: opts?.defaultCost ?? 0,
      defaultSellingPrice: opts?.defaultSellingPrice ?? 0,
      tracksLots: opts?.tracksLots ?? false,
      tracksSerialNumbers: opts?.tracksSerialNumbers ?? false,
      ...(opts?.taxId ? { taxId: opts.taxId } : {}),
      ...(opts?.taxExempt ? { taxExempt: true } : {}),
    })
    .expect(201);
  return { productId: res.body.data.id as string, variantId: res.body.data.variants[0].id as string };
}
