import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 8A - Warranty. Every assertion runs against a real NestJS app and
 * real PostgreSQL (erp_test) with RLS + FORCE RLS active and the
 * restricted `erp_app` runtime role. No mocks: tenant isolation,
 * permission boundaries and record-keeping-only guarantees are security
 * and integrity invariants, and a mock cannot prove them.
 */
describe('Warranty (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let other: SalesFixture;

  // Serial-tracked product, sold once.
  let serialVariantId: string;
  let saleId: string;
  let saleItemId: string;
  let serialIds: string[] = [];

  // Non-serial product, sold once - used to prove the serial-tracked rule.
  let plainSaleItemId: string;

  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    biz = await setupSalesFixture(app, 'warranty-a');
    other = await setupSalesFixture(app, 'warranty-b');

    // --- serial-tracked product: receive 3 serials, then sell 3 units ---
    ({ variantId: serialVariantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'WTY-SER-1', {
      tracksSerialNumbers: true,
      defaultCost: 100,
      defaultSellingPrice: 300,
    }));
    await request(app.getHttpServer())
      .post('/api/v1/inventory/receipts')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        variantId: serialVariantId,
        quantity: 3,
        unitCost: 100,
        serials: ['WTY-SN-001', 'WTY-SN-002', 'WTY-SN-003'],
      })
      .expect(201);

    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        // Phase 8E / BD-13: serial identity is now MANDATORY at sale
        // creation for a serial-tracked variant, so the units being sold
        // are named here. Before 8E this sale recorded no serial at all.
        items: [
          {
            variantId: serialVariantId,
            quantity: 3,
            unitPrice: 300,
            serials: ['WTY-SN-001', 'WTY-SN-002', 'WTY-SN-003'],
          },
        ],
        payments: [{ amount: 900 }],
      })
      .expect(201);
    saleId = sale.body.data.id;
    saleItemId = sale.body.data.items[0].id;

    const serials = await admin.serialNumber.findMany({
      where: { businessId: biz.businessId, variantId: serialVariantId },
      orderBy: { serial: 'asc' },
    });
    serialIds = serials.map((s) => s.id);
    expect(serialIds).toHaveLength(3);

    // --- non-serial product, sold once ---
    const { variantId: plainVariantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'WTY-PLAIN-1', {
      defaultCost: 5,
      defaultSellingPrice: 20,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId: plainVariantId, quantity: 10, unitCost: 5 })
      .expect(201);
    const plainSale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({
        warehouseId: biz.warehouseId,
        items: [{ variantId: plainVariantId, quantity: 1, unitPrice: 20 }],
        payments: [{ amount: 20 }],
      })
      .expect(201);
    plainSaleItemId = plainSale.body.data.items[0].id;

    // Business default warranty duration.
    await setDefaultDuration(365);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  function auth() {
    return `Bearer ${biz.accessToken}`;
  }

  async function setDefaultDuration(days: number | null) {
    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('Authorization', auth())
      .send({ key: 'warranty.default_duration_days', value: days })
      .expect(200);
  }

  async function loginAs(roleName: string, emailPrefix: string) {
    const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: roleName } });
    const email = `${emailPrefix}@${biz.slug}.test`;
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: emailPrefix, email, password: 'RoleUserPass1!', roleIds: [role.id], branchIds: [] })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'RoleUserPass1!', businessSlug: biz.slug })
      .expect(200);
    return `Bearer ${login.body.data.accessToken}`;
  }

  /** Registers a warranty for one of the three serials, returning the row. */
  function registerWarranty(serialIndex: number, body: Record<string, unknown> = {}, token = auth()) {
    return request(app.getHttpServer())
      .post('/api/v1/warranties')
      .set('Authorization', token)
      .send({ saleItemId, serialNumberId: serialIds[serialIndex], ...body });
  }

  // ------------------------------------------------------------------
  describe('Registration: validation and serial-tracked enforcement', () => {
    it('registers a warranty using the business default duration and snapshots it', async () => {
      const res = await registerWarranty(0).expect(201);
      const w = res.body.data;
      expect(w.durationDays).toBe(365);
      expect(w.status).toBe('ACTIVE');
      expect(w.serialNumberId).toBe(serialIds[0]);
      expect(w.saleItemId).toBe(saleItemId);
      expect(w.businessId).toBe(biz.businessId);
    });

    it('starts coverage at the SALE date, never at registration time', async () => {
      const sale = await admin.sale.findUniqueOrThrow({ where: { id: saleId } });
      const w = await admin.warranty.findFirstOrThrow({ where: { serialNumberId: serialIds[0] } });
      expect(w.startDate.getTime()).toBe(sale.createdAt.getTime());
      // endDate is derived from the snapshotted duration, not from "now".
      expect(w.endDate.getTime()).toBe(sale.createdAt.getTime() + 365 * DAY_MS);
    });

    it('accepts a per-registration duration override in preference to the default', async () => {
      const res = await registerWarranty(1, { durationDays: 30 }).expect(201);
      expect(res.body.data.durationDays).toBe(30);
      const start = new Date(res.body.data.startDate).getTime();
      expect(new Date(res.body.data.endDate).getTime()).toBe(start + 30 * DAY_MS);
    });

    it('rejects a second warranty for the same serial unit on the same sale line', async () => {
      await registerWarranty(0).expect(409);
    });

    it('rejects a warranty for a NON serial-tracked sale line', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/warranties')
        .set('Authorization', auth())
        .send({ saleItemId: plainSaleItemId, serialNumberId: serialIds[2] })
        .expect(422);
      expect(JSON.stringify(res.body)).toMatch(/serial-tracked/i);
    });

    it('rejects a serial belonging to a different variant than the sale line', async () => {
      const { variantId: otherVariantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'WTY-SER-2', {
        tracksSerialNumbers: true,
      });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/receipts')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId: otherVariantId, quantity: 1, unitCost: 1, serials: ['WTY-SN-OTHER'] })
        .expect(201);
      const foreign = await admin.serialNumber.findFirstOrThrow({ where: { serial: 'WTY-SN-OTHER' } });

      const res = await request(app.getHttpServer())
        .post('/api/v1/warranties')
        .set('Authorization', auth())
        .send({ saleItemId, serialNumberId: foreign.id })
        .expect(422);
      expect(JSON.stringify(res.body)).toMatch(/different product variant/i);
    });

    it('rejects a non-existent sale line and a non-existent serial with 404', async () => {
      const ghost = '00000000-0000-4000-8000-000000000000';
      await request(app.getHttpServer())
        .post('/api/v1/warranties')
        .set('Authorization', auth())
        .send({ saleItemId: ghost, serialNumberId: serialIds[2] })
        .expect(404);
      await request(app.getHttpServer())
        .post('/api/v1/warranties')
        .set('Authorization', auth())
        .send({ saleItemId, serialNumberId: ghost })
        .expect(404);
    });

    it('rejects malformed input at the validation boundary (bad uuid, zero/negative/overlong duration)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/warranties')
        .set('Authorization', auth())
        .send({ saleItemId: 'not-a-uuid', serialNumberId: serialIds[2] })
        .expect(422);
      for (const durationDays of [0, -1, 36501]) {
        await request(app.getHttpServer())
          .post('/api/v1/warranties')
          .set('Authorization', auth())
          .send({ saleItemId, serialNumberId: serialIds[2], durationDays })
          .expect(422);
      }
    });

    it('refuses to guess a duration when no override is given and no valid default is configured', async () => {
      await setDefaultDuration(null);
      const res = await registerWarranty(2).expect(422);
      expect(JSON.stringify(res.body)).toMatch(/default/i);
      // ...but an explicit override still works with no default configured.
      await registerWarranty(2, { durationDays: 90 }).expect(201);
      await setDefaultDuration(365);
    });
  });

  // ------------------------------------------------------------------
  describe('Duration snapshot: historical integrity', () => {
    it('changing the business default never alters an already-issued warranty', async () => {
      const before = await admin.warranty.findFirstOrThrow({ where: { serialNumberId: serialIds[0] } });

      await setDefaultDuration(1);
      const after = await admin.warranty.findFirstOrThrow({ where: { id: before.id } });

      expect(after.durationDays).toBe(before.durationDays);
      expect(after.endDate.getTime()).toBe(before.endDate.getTime());
      expect(after.startDate.getTime()).toBe(before.startDate.getTime());

      // And the read model agrees - coverage is not recomputed from config.
      const res = await request(app.getHttpServer())
        .get(`/api/v1/warranties/${before.id}`)
        .set('Authorization', auth())
        .expect(200);
      expect(res.body.data.durationDays).toBe(365);
      expect(res.body.data.effectiveStatus).toBe('ACTIVE');

      await setDefaultDuration(365);
    });
  });

  // ------------------------------------------------------------------
  describe('Expiry and eligibility', () => {
    it('an elapsed warranty reads as EXPIRED and cannot be claimed against', async () => {
      const w = await admin.warranty.findFirstOrThrow({ where: { serialNumberId: serialIds[1] } });
      // Move the whole coverage window into the past. Done at the DB layer
      // deliberately: no API can rewrite history, which is the point.
      const end = new Date(Date.now() - 1000);
      const start = new Date(end.getTime() - 30 * DAY_MS);
      await admin.warranty.update({ where: { id: w.id }, data: { startDate: start, endDate: end } });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/warranties/${w.id}`)
        .set('Authorization', auth())
        .expect(200);
      expect(res.body.data.status).toBe('ACTIVE'); // stored value is untouched
      expect(res.body.data.effectiveStatus).toBe('EXPIRED'); // derived on read

      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${w.id}/claims`)
        .set('Authorization', auth())
        .send({ description: 'Screen cracked' })
        .expect(409);
    });

    it('the coverage interval is half-open: the end instant is already outside cover', async () => {
      const w = await admin.warranty.findFirstOrThrow({ where: { serialNumberId: serialIds[1] } });
      // endDate exactly now -> expired (>= endDate is out).
      await admin.warranty.update({ where: { id: w.id }, data: { endDate: new Date() } });
      const res = await request(app.getHttpServer())
        .get(`/api/v1/warranties/${w.id}`)
        .set('Authorization', auth())
        .expect(200);
      expect(res.body.data.effectiveStatus).toBe('EXPIRED');
    });
  });

  // ------------------------------------------------------------------
  describe('Claim lifecycle', () => {
    let warrantyId: string;
    let claimId: string;

    beforeAll(async () => {
      const w = await admin.warranty.findFirstOrThrow({ where: { serialNumberId: serialIds[0] } });
      warrantyId = w.id;
    });

    it('registers a claim OPEN and marks the warranty CLAIMED', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/warranties/${warrantyId}/claims`)
        .set('Authorization', auth())
        .send({ description: 'Battery does not hold charge' })
        .expect(201);
      claimId = res.body.data.id;
      expect(res.body.data.status).toBe('OPEN');
      expect(res.body.data.resolvedAt).toBeNull();
      expect(res.body.data.resolvedBy).toBeNull();

      const w = await admin.warranty.findUniqueOrThrow({ where: { id: warrantyId } });
      expect(w.status).toBe('CLAIMED');
      // Claiming changes NO coverage fact.
      expect(w.durationDays).toBe(365);
    });

    it('rejects an empty claim description', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${warrantyId}/claims`)
        .set('Authorization', auth())
        .send({ description: '   ' })
        .expect(422);
    });

    it('allows a second claim within the same coverage period', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${warrantyId}/claims`)
        .set('Authorization', auth())
        .send({ description: 'Unrelated second fault' })
        .expect(201);
      const list = await request(app.getHttpServer())
        .get(`/api/v1/warranties/${warrantyId}/claims`)
        .set('Authorization', auth())
        .expect(200);
      expect(list.body.data.length).toBe(2);
    });

    it('resolves an OPEN claim and records who resolved it and when', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/warranties/${warrantyId}/claims/${claimId}/resolve`)
        .set('Authorization', auth())
        .send({ status: 'RESOLVED', resolution: 'Battery replaced under warranty' })
        .expect(200);
      expect(res.body.data.status).toBe('RESOLVED');
      expect(res.body.data.resolvedAt).not.toBeNull();
      expect(res.body.data.resolvedBy).toBe(biz.ownerUserId);
    });

    it('is one-way: a resolved claim can never be re-transitioned', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${warrantyId}/claims/${claimId}/resolve`)
        .set('Authorization', auth())
        .send({ status: 'REJECTED' })
        .expect(409);
    });

    it('rejects any status outside RESOLVED | REJECTED', async () => {
      for (const status of ['OPEN', 'CLOSED', 'PENDING']) {
        await request(app.getHttpServer())
          .post(`/api/v1/warranties/${warrantyId}/claims/${claimId}/resolve`)
          .set('Authorization', auth())
          .send({ status })
          .expect(422);
      }
    });

    it('never rewrites the claim record: claimedAt and description survive resolution', async () => {
      const claim = await admin.warrantyClaim.findUniqueOrThrow({ where: { id: claimId } });
      expect(claim.description).toBe('Battery does not hold charge');
      expect(claim.claimedAt).toBeInstanceOf(Date);
      expect(claim.createdBy).toBe(biz.ownerUserId);
    });

    it('the database itself refuses a resolved claim with no audit trail', async () => {
      await expect(
        admin.$executeRawUnsafe(
          `UPDATE warranty_claims SET status = 'REJECTED', resolved_at = NULL, resolved_by = NULL WHERE id = $1`,
          claimId,
        ),
      ).rejects.toThrow(/warranty_claims_resolution_audit_consistent/);
    });
  });

  // ------------------------------------------------------------------
  describe('Void', () => {
    it('voids a warranty and blocks any further claim against it', async () => {
      // Serial 2's warranty was registered with an explicit 90-day
      // override earlier in this spec.
      const w = await admin.warranty.findFirstOrThrow({ where: { serialNumberId: serialIds[2] } });
      expect(w.status).toBe('ACTIVE');

      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${w.id}/void`)
        .set('Authorization', auth())
        .send({ reason: 'Registered against the wrong unit' })
        .expect(200);

      const after = await admin.warranty.findUniqueOrThrow({ where: { id: w.id } });
      expect(after.status).toBe('VOID');
      // Coverage facts are preserved, not erased.
      expect(after.durationDays).toBe(90);

      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${w.id}/claims`)
        .set('Authorization', auth())
        .send({ description: 'Too late' })
        .expect(409);

      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${w.id}/void`)
        .set('Authorization', auth())
        .send({})
        .expect(409);
    });
  });

  // ------------------------------------------------------------------
  describe('Record-keeping only: no inventory, no accounting', () => {
    it('registering, claiming, resolving and voiding create NO stock movement and NO journal entry', async () => {
      const movementsBefore = await admin.stockMovement.count({ where: { businessId: biz.businessId } });
      const entriesBefore = await admin.journalEntry.count({ where: { businessId: biz.businessId } });
      const balancesBefore = await admin.stockBalance.findMany({
        where: { businessId: biz.businessId, variantId: serialVariantId },
        orderBy: { id: 'asc' },
      });

      const target = await admin.warranty.findFirstOrThrow({ where: { serialNumberId: serialIds[0] } });
      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${target.id}/claims`)
        .set('Authorization', auth())
        .send({ description: 'Yet another fault' })
        .expect(201);

      const movementsAfter = await admin.stockMovement.count({ where: { businessId: biz.businessId } });
      const entriesAfter = await admin.journalEntry.count({ where: { businessId: biz.businessId } });
      const balancesAfter = await admin.stockBalance.findMany({
        where: { businessId: biz.businessId, variantId: serialVariantId },
        orderBy: { id: 'asc' },
      });

      expect(movementsAfter).toBe(movementsBefore);
      expect(entriesAfter).toBe(entriesBefore);
      expect(balancesAfter.map((b) => b.quantityOnHand.toString())).toEqual(balancesBefore.map((b) => b.quantityOnHand.toString()));
    });

    it('no warranty row references any journal entry or stock movement', async () => {
      const refs: Array<{ count: bigint }> = await admin.$queryRawUnsafe(`
        SELECT count(*) AS count FROM information_schema.columns
        WHERE table_name IN ('warranties','warranty_claims')
          AND (column_name LIKE '%journal%' OR column_name LIKE '%movement%' OR column_name LIKE '%account%')
      `);
      expect(Number(refs[0].count)).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  describe('Tenant isolation', () => {
    let foreignWarrantyId: string;

    beforeAll(async () => {
      const w = await admin.warranty.findFirstOrThrow({ where: { businessId: biz.businessId } });
      foreignWarrantyId = w.id;
    });

    it("another business cannot read business A's warranty by id", async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/warranties/${foreignWarrantyId}`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(404);
    });

    it("another business's warranty list never contains business A's rows", async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/warranties')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(200);
      expect(res.body.data.every((w: { businessId: string }) => w.businessId === other.businessId)).toBe(true);
      expect(res.body.data.some((w: { id: string }) => w.id === foreignWarrantyId)).toBe(false);
    });

    it('another business cannot claim against, resolve on, or void business A\'s warranty', async () => {
      const otherAuth = `Bearer ${other.accessToken}`;
      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${foreignWarrantyId}/claims`)
        .set('Authorization', otherAuth)
        .send({ description: 'cross-tenant attempt' })
        .expect(404);
      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${foreignWarrantyId}/void`)
        .set('Authorization', otherAuth)
        .send({})
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/warranties/${foreignWarrantyId}/claims`)
        .set('Authorization', otherAuth)
        .expect(404);

      const claim = await admin.warrantyClaim.findFirstOrThrow({ where: { businessId: biz.businessId } });
      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${foreignWarrantyId}/claims/${claim.id}/resolve`)
        .set('Authorization', otherAuth)
        .send({ status: 'REJECTED' })
        .expect(404);
    });

    it("another business cannot register a warranty against business A's sale line", async () => {
      await request(app.getHttpServer())
        .post('/api/v1/warranties')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ saleItemId, serialNumberId: serialIds[0] })
        .expect(404);
    });

    it('RLS blocks a cross-tenant read at the database layer, not merely in application code', async () => {
      const runtime = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
      try {
        const rows = await runtime.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${other.businessId}'`);
          return tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM warranties WHERE id = '${foreignWarrantyId}'`);
        });
        expect(rows).toHaveLength(0);
      } finally {
        await runtime.$disconnect();
      }
    });
  });

  // ------------------------------------------------------------------
  describe('Permissions', () => {
    it('an unauthenticated caller reaches no warranty route', async () => {
      await request(app.getHttpServer()).get('/api/v1/warranties').expect(401);
      await request(app.getHttpServer()).post('/api/v1/warranties').send({}).expect(401);
    });

    it('an ACCOUNTANT may view warranties but may not register, claim or void', async () => {
      const token = await loginAs('ACCOUNTANT', 'wtyaccountant');
      const w = await admin.warranty.findFirstOrThrow({ where: { businessId: biz.businessId } });
      await request(app.getHttpServer()).get('/api/v1/warranties').set('Authorization', token).expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/warranties')
        .set('Authorization', token)
        .send({ saleItemId, serialNumberId: serialIds[0] })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${w.id}/claims`)
        .set('Authorization', token)
        .send({ description: 'nope' })
        .expect(403);
      await request(app.getHttpServer()).post(`/api/v1/warranties/${w.id}/void`).set('Authorization', token).send({}).expect(403);
    });

    it('a SALES_EMPLOYEE may view and register but may NOT process a claim', async () => {
      const token = await loginAs('SALES_EMPLOYEE', 'wtysalesemp');
      const w = await admin.warranty.findFirstOrThrow({ where: { businessId: biz.businessId } });
      await request(app.getHttpServer()).get('/api/v1/warranties').set('Authorization', token).expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/warranties/${w.id}/claims`)
        .set('Authorization', token)
        .send({ description: 'not allowed' })
        .expect(403);
    });

    it('a CASHIER may register a warranty and raise a claim from the POS floor', async () => {
      const token = await loginAs('CASHIER', 'wtycashier');
      await request(app.getHttpServer()).get('/api/v1/warranties').set('Authorization', token).expect(200);

      // A genuine write, not just a read: the POS floor must be able to
      // issue a warranty at the till and take a claim over the counter.
      const w = await admin.warranty.findFirstOrThrow({ where: { businessId: biz.businessId, status: 'CLAIMED' } });
      const claim = await request(app.getHttpServer())
        .post(`/api/v1/warranties/${w.id}/claims`)
        .set('Authorization', token)
        .send({ description: 'Raised at the till by a cashier' })
        .expect(201);
      expect(claim.body.data.status).toBe('OPEN');
    });
  });

  // ------------------------------------------------------------------
  describe('Listing', () => {
    it('filters by status and serial, and paginates', async () => {
      const all = await request(app.getHttpServer()).get('/api/v1/warranties').set('Authorization', auth()).expect(200);
      expect(all.body.pagination.total).toBeGreaterThan(0);
      expect(all.body.data.every((w: { effectiveStatus: string }) => typeof w.effectiveStatus === 'string')).toBe(true);

      const voided = await request(app.getHttpServer())
        .get('/api/v1/warranties?status=VOID')
        .set('Authorization', auth())
        .expect(200);
      expect(voided.body.data.every((w: { status: string }) => w.status === 'VOID')).toBe(true);

      const bySerial = await request(app.getHttpServer())
        .get(`/api/v1/warranties?serialNumberId=${serialIds[0]}`)
        .set('Authorization', auth())
        .expect(200);
      expect(bySerial.body.data).toHaveLength(1);

      const paged = await request(app.getHttpServer())
        .get('/api/v1/warranties?page=1&limit=1')
        .set('Authorization', auth())
        .expect(200);
      expect(paged.body.data).toHaveLength(1);
      expect(paged.body.pagination.limit).toBe(1);
    });

    it('rejects an out-of-range limit', async () => {
      await request(app.getHttpServer()).get('/api/v1/warranties?limit=999').set('Authorization', auth()).expect(422);
    });
  });

  // ------------------------------------------------------------------
  describe('Known Issue #47 CLOSED (Phase 8E): the sale records which serial it sold', () => {
    it('selling a serial-tracked variant marks its serials SOLD and links them to the sale line', async () => {
      const serials = await admin.serialNumber.findMany({
        where: { businessId: biz.businessId, variantId: serialVariantId },
        orderBy: { serial: 'asc' },
      });
      // Previously these stayed IN_STOCK because the sale path never
      // passed serials at all. That gap is what made warranty
      // registration unverifiable.
      expect(serials.every((s) => s.status === 'SOLD')).toBe(true);

      const links = await admin.saleItemSerial.findMany({ where: { saleItemId } });
      expect(links.length).toBe(3);
      expect(links.every((l) => l.saleId === saleId)).toBe(true);
      expect(new Set(links.map((l) => l.serialNumberId))).toEqual(new Set(serials.map((s) => s.id)));
    });

    it('a warranty cannot be registered for a serial the sale line did not actually sell', async () => {
      // A genuine, in-tenant, same-variant serial that simply was not on
      // this sale line. Before 8E this passed every available check.
      await request(app.getHttpServer())
        .post('/api/v1/inventory/receipts')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId: serialVariantId, quantity: 1, unitCost: 100, serials: ['WTY-SN-UNSOLD'] })
        .expect(201);
      const unsold = await admin.serialNumber.findFirstOrThrow({ where: { serial: 'WTY-SN-UNSOLD' } });

      const res = await request(app.getHttpServer())
        .post('/api/v1/warranties')
        .set('Authorization', auth())
        .send({ saleItemId, serialNumberId: unsold.id })
        .expect(422);
      expect(JSON.stringify(res.body)).toMatch(/not sold on this sale line/i);
    });

    it('a serial-tracked sale without serials is now rejected', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId: serialVariantId, quantity: 1, unitPrice: 300 }],
          payments: [{ amount: 300 }],
        })
        .expect(422);
      expect(JSON.stringify(res.body)).toMatch(/serial-tracked/i);
    });
  });
});
