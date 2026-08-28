import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { setupInventoryFixture, InventoryFixture } from './inventory-fixtures';

export interface PurchasingFixture extends InventoryFixture {
  supplierId: string;
}

/** Registers a fresh business (with its Piece/Carton UOMs) and one supplier. */
export async function setupPurchasingFixture(app: INestApplication, slugSuffix: string): Promise<PurchasingFixture> {
  const biz = await setupInventoryFixture(app, slugSuffix);
  const auth = `Bearer ${biz.accessToken}`;

  const supplier = await request(app.getHttpServer())
    .post('/api/v1/purchasing/suppliers')
    .set('Authorization', auth)
    .send({ name: `Supplier ${slugSuffix}` })
    .expect(201);

  return { ...biz, supplierId: supplier.body.data.id };
}

/** Creates and approves a purchase in one call - the common starting point for receiving/return tests. */
export async function createApprovedPurchase(
  app: INestApplication,
  token: string,
  biz: PurchasingFixture,
  items: { variantId: string; quantityOrdered: number; unitCost: number }[],
): Promise<string> {
  const auth = `Bearer ${token}`;
  const created = await request(app.getHttpServer())
    .post('/api/v1/purchasing/purchases')
    .set('Authorization', auth)
    .send({ warehouseId: biz.warehouseId, supplierId: biz.supplierId, items })
    .expect(201);
  const purchaseId = created.body.data.id as string;
  await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${purchaseId}/approve`).set('Authorization', auth).expect(200);
  return purchaseId;
}
