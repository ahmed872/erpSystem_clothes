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


/**
 * Phase 10 (BD-18): creates a tax and makes it the business default, so
 * every product without its own tax is charged at `ratePercent`.
 *
 * Tests that previously passed `taxAmount` in the sale request now configure
 * a real tax instead - which is a strictly stronger check, because the tax
 * they assert is one the SERVER computed rather than one they asserted the
 * server echoed back.
 */
export async function setupDefaultTax(app: INestApplication, accessToken: string, ratePercent: number, name = 'Standard'): Promise<string> {
  const taxId = await createTax(app, accessToken, ratePercent, name);

  await request(app.getHttpServer())
    .put('/api/v1/settings/tax')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ defaultTaxId: taxId })
    .expect(200);

  return taxId;
}

/**
 * Creates a tax WITHOUT making it the business default, so it can be
 * attached to one product only. Tests that need a single taxed product
 * use this rather than `setupDefaultTax`, which would change the total of
 * every other sale in the same spec.
 */
let taxNameSeq = 0;
export async function createTax(app: INestApplication, accessToken: string, ratePercent: number, name = `Tax ${ratePercent} #${++taxNameSeq}`): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/taxes')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name, ratePercent })
    .expect(201);
  return res.body.data.id;
}

/** Switches the business between EXCLUSIVE and INCLUSIVE pricing. */
export async function setTaxPricingMode(app: INestApplication, accessToken: string, mode: 'EXCLUSIVE' | 'INCLUSIVE'): Promise<void> {
  await request(app.getHttpServer())
    .put('/api/v1/settings/tax')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ taxPricingMode: mode })
    .expect(200);
}
