import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { registerAndLogin, RegisteredBusiness } from './utils/register-and-login';

interface PosWarehouse {
  id: string;
  name: string;
  branchId: string;
  branchName: string;
  isDefault: boolean;
}

/**
 * Phase 12 BLOCKING-B — GET /sales/shifts/available-warehouses.
 *
 * `POST /sales/shifts/open` needs a `warehouseId`, but `GET /warehouses`
 * requires `warehouses.view`, a permission NONE of the POS-selling role
 * templates (Cashier, Sales Employee) hold and this fix deliberately does
 * not grant them. This proves the POS-safe alternative: scoped to exactly
 * the warehouses the caller may actually sell from (via the existing
 * `UserBranch` model, no new permission invented), safe on a business's
 * very first morning (before any sale/inventory-balance row exists), and
 * refusing outright — never handing back an unrelated warehouse — when
 * nothing is authorized.
 */
describe('Phase 12 BLOCKING-B: GET /sales/shifts/available-warehouses (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: RegisteredBusiness;
  let other: RegisteredBusiness;
  let seq = 0;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await registerAndLogin(app, 'pos-wh');
    other = await registerAndLogin(app, 'pos-wh-other');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const discover = (token: string) =>
    request(app.getHttpServer()).get('/api/v1/sales/shifts/available-warehouses').set('Authorization', `Bearer ${token}`);

  async function makeUser(businessSlugOwnerToken: string, businessId: string, roleName: string, branchIds: string[]) {
    const role = await admin.role.findFirstOrThrow({ where: { businessId, name: roleName } });
    const email = `poswh${seq++}@e2e.test`;
    const password = 'RoleUserPass1!';
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${businessSlugOwnerToken}`)
      .send({ name: `poswh ${roleName}`, email, password, roleIds: [role.id], branchIds })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, businessSlug: biz.slug })
      .expect(200);
    return { id: created.body.data.id as string, accessToken: login.body.data.accessToken as string };
  }

  it('the FIRST MORNING scenario: the owner discovers the onboarding default warehouse with zero prior sales/inventory history', async () => {
    // This runs against `biz` before any sale, shift, or stock movement of
    // any kind has ever been created for it — the exact "no history to
    // accidentally reveal a warehouse id" case the contract must handle.
    const res = await discover(biz.accessToken).expect(200);
    const warehouses: PosWarehouse[] = res.body.data;
    expect(warehouses).toHaveLength(1);
    expect(warehouses[0]).toMatchObject({ id: biz.warehouseId, branchId: biz.branchId, isDefault: true });
  });

  it('a Cashier assigned to exactly one branch gets exactly one warehouse back — safe for frontend auto-select', async () => {
    const cashier = await makeUser(biz.accessToken, biz.businessId, 'CASHIER', [biz.branchId]);
    const res = await discover(cashier.accessToken).expect(200);
    const warehouses: PosWarehouse[] = res.body.data;
    expect(warehouses).toHaveLength(1);
    expect(warehouses[0].id).toBe(biz.warehouseId);
  });

  it('a Cashier assigned to no branch gets a clear business error, never an unrelated warehouse', async () => {
    const cashier = await makeUser(biz.accessToken, biz.businessId, 'CASHIER', []);
    const res = await discover(cashier.accessToken).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    // The error must not itself leak the warehouse it is refusing to hand over.
    expect(JSON.stringify(res.body)).not.toContain(biz.warehouseId);
  });

  it('multiple authorized contexts: a Cashier assigned to two branches sees both warehouses and no others', async () => {
    const branch2 = await request(app.getHttpServer())
      .post('/api/v1/branches')
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .send({ name: 'Second Branch' })
      .expect(201);
    const warehouse2 = await request(app.getHttpServer())
      .post('/api/v1/warehouses')
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .send({ branchId: branch2.body.data.id, name: 'Second Warehouse' })
      .expect(201);

    const cashier = await makeUser(biz.accessToken, biz.businessId, 'CASHIER', [biz.branchId, branch2.body.data.id]);
    const res = await discover(cashier.accessToken).expect(200);
    const warehouses: PosWarehouse[] = res.body.data;
    const ids = warehouses.map((w) => w.id).sort();
    expect(ids).toEqual([biz.warehouseId, warehouse2.body.data.id].sort());
  });

  it('no unauthorized warehouse leakage: a Cashier assigned to only branch A never sees branch B\'s warehouse', async () => {
    const branchB = await request(app.getHttpServer())
      .post('/api/v1/branches')
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .send({ name: 'Leak Check Branch' })
      .expect(201);
    const warehouseB = await request(app.getHttpServer())
      .post('/api/v1/warehouses')
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .send({ branchId: branchB.body.data.id, name: 'Leak Check Warehouse' })
      .expect(201);

    const cashier = await makeUser(biz.accessToken, biz.businessId, 'CASHIER', [biz.branchId]);
    const res = await discover(cashier.accessToken).expect(200);
    const ids: string[] = res.body.data.map((w: PosWarehouse) => w.id);
    expect(ids).not.toContain(warehouseB.body.data.id);
  });

  it('an inactive warehouse is not usable for the current sale context and is excluded', async () => {
    const branchC = await request(app.getHttpServer())
      .post('/api/v1/branches')
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .send({ name: 'Inactive Warehouse Branch' })
      .expect(201);
    const warehouseC = await request(app.getHttpServer())
      .post('/api/v1/warehouses')
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .send({ branchId: branchC.body.data.id, name: 'Soon Inactive Warehouse' })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/api/v1/warehouses/${warehouseC.body.data.id}`)
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .send({ isActive: false })
      .expect(200);

    const cashier = await makeUser(biz.accessToken, biz.businessId, 'CASHIER', [branchC.body.data.id]);
    await discover(cashier.accessToken).expect(422); // the only assigned branch now has zero ACTIVE warehouses
  });

  it.each(['BRANCH_MANAGER', 'ACCOUNTANT', 'INVENTORY_MANAGER'])(
    'roles that cannot sell (%s, no shifts.open) do not accidentally gain sales access here',
    async (roleName) => {
      const user = await makeUser(biz.accessToken, biz.businessId, roleName, [biz.branchId]);
      const res = await discover(user.accessToken).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    },
  );

  it('rejects an unauthenticated request with 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/sales/shifts/available-warehouses').expect(401);
  });

  it('cross-tenant isolation: a caller in one business never sees another business\'s warehouses', async () => {
    const resA = await discover(biz.accessToken).expect(200);
    const idsA: string[] = resA.body.data.map((w: PosWarehouse) => w.id);
    expect(idsA).not.toContain(other.warehouseId);

    const resB = await discover(other.accessToken).expect(200);
    const idsB: string[] = resB.body.data.map((w: PosWarehouse) => w.id);
    expect(idsB).not.toContain(biz.warehouseId);
    expect(idsB).toEqual([other.warehouseId]);
  });

  it('a caller holding warehouses.view (Owner) sees every active warehouse tenant-wide — existing warehouse authorization is unchanged', async () => {
    // Reconfirm what GET /warehouses itself would show the Owner, then
    // confirm this POS-safe endpoint agrees with it exactly for a caller
    // who already holds full visibility — nothing was taken away.
    const canonical = await request(app.getHttpServer())
      .get('/api/v1/warehouses')
      .set('Authorization', `Bearer ${biz.accessToken}`)
      .expect(200);
    const activeCanonicalIds = canonical.body.data
      .filter((w: { isActive: boolean }) => w.isActive)
      .map((w: { id: string }) => w.id)
      .sort();

    const res = await discover(biz.accessToken).expect(200);
    const ids: string[] = res.body.data.map((w: PosWarehouse) => w.id).sort();
    expect(ids).toEqual(activeCanonicalIds);
  });

  it('existing warehouse authorization is unchanged: a Cashier still cannot reach GET /warehouses (warehouses.view was not granted)', async () => {
    const cashier = await makeUser(biz.accessToken, biz.businessId, 'CASHIER', [biz.branchId]);
    const res = await request(app.getHttpServer())
      .get('/api/v1/warehouses')
      .set('Authorization', `Bearer ${cashier.accessToken}`)
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('a Sales Employee (also POS-selling, no warehouses.view) resolves the same way as a Cashier', async () => {
    const employee = await makeUser(biz.accessToken, biz.businessId, 'SALES_EMPLOYEE', [biz.branchId]);
    const res = await discover(employee.accessToken).expect(200);
    const warehouses: PosWarehouse[] = res.body.data;
    expect(warehouses).toHaveLength(1);
    expect(warehouses[0].id).toBe(biz.warehouseId);
  });

  it('the discovered warehouse actually works to open a shift (the contract this endpoint exists to serve)', async () => {
    const cashier = await makeUser(biz.accessToken, biz.businessId, 'CASHIER', [biz.branchId]);
    const discovered = await discover(cashier.accessToken).expect(200);
    const warehouseId: string = discovered.body.data[0].id;

    const register = await admin.cashRegister.findFirstOrThrow({ where: { businessId: biz.businessId, branchId: biz.branchId } });
    await request(app.getHttpServer())
      .post('/api/v1/sales/shifts/open')
      .set('Authorization', `Bearer ${cashier.accessToken}`)
      .send({ warehouseId, cashRegisterId: register.id, openingFloat: 0 })
      .expect(201);
  });
});
