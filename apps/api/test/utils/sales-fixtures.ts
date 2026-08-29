import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { setupInventoryFixture, InventoryFixture } from './inventory-fixtures';

export interface SalesFixture extends InventoryFixture {
  activeShiftId: string;
}

/** Registers a fresh business (with its Piece/Carton UOMs) and opens a shift for the owner. */
export async function setupSalesFixture(app: INestApplication, slugSuffix: string): Promise<SalesFixture> {
  const biz = await setupInventoryFixture(app, slugSuffix);
  const auth = `Bearer ${biz.accessToken}`;

  const shift = await request(app.getHttpServer())
    .post('/api/v1/sales/shifts/open')
    .set('Authorization', auth)
    .send({ warehouseId: biz.warehouseId })
    .expect(201);

  return { ...biz, activeShiftId: shift.body.data.id };
}
