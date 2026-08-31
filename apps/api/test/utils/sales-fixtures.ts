import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { setupInventoryFixture, InventoryFixture } from './inventory-fixtures';

export interface SalesFixture extends InventoryFixture {
  activeShiftId: string;
  /** The default register created at onboarding (Phase 0 §11, Phase 10). */
  cashRegisterId: string;
}

/**
 * Registers a fresh business (with its Piece/Carton UOMs) and opens a shift
 * for the owner.
 *
 * Phase 10 (BD-17 rule 2): opening a shift now requires the cash register
 * and the opening float. The register is the one business registration
 * creates by default, so this stays a single call from a caller's point of
 * view. `openingFloat` defaults to 0 here, which keeps every pre-existing
 * test's expected cash equal to its cash takings exactly as before.
 */
export async function setupSalesFixture(app: INestApplication, slugSuffix: string): Promise<SalesFixture> {
  const biz = await setupInventoryFixture(app, slugSuffix);
  const auth = `Bearer ${biz.accessToken}`;

  const registers = await request(app.getHttpServer())
    .get('/api/v1/cash-registers')
    .set('Authorization', auth)
    .expect(200);
  const cashRegisterId: string = registers.body.data[0].id;

  const shift = await request(app.getHttpServer())
    .post('/api/v1/sales/shifts/open')
    .set('Authorization', auth)
    .send({ warehouseId: biz.warehouseId, cashRegisterId, openingFloat: 0 })
    .expect(201);

  return { ...biz, activeShiftId: shift.body.data.id, cashRegisterId };
}
