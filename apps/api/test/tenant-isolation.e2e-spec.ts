import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';

/**
 * Proves tenant isolation at TWO independent layers, per
 * docs/architecture/PHASE-0-ARCHITECTURE.md §5:
 *  1) the API layer (a tenant B user simply cannot see tenant A's data
 *     through any endpoint), and
 *  2) the database layer itself (PostgreSQL Row-Level Security), by
 *     connecting AS THE SAME RESTRICTED erp_app ROLE the API uses,
 *     issuing a completely raw query with NO application-level
 *     `WHERE business_id = ...` filter at all, and confirming Postgres
 *     itself returns zero rows without the right `app.current_tenant_id`
 *     session variable set. This is the test that would fail if RLS were
 *     ever accidentally disabled while the application code "forgot" a
 *     tenant filter.
 */
describe('Tenant isolation - API layer + PostgreSQL RLS (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let appRoleClient: PrismaClient;

  let bizA: { id: string; token: string; branchId: string };
  let bizB: { id: string; token: string; branchId: string };

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    appRoleClient = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });

    const regA = await request(app.getHttpServer()).post('/api/v1/businesses/register').send({
      businessName: 'Tenant A',
      businessSlug: 'tenant-a-e2e',
      ownerName: 'Owner A',
      ownerEmail: 'owner@tenant-a.test',
      ownerPassword: 'Sup3rSecretA!',
    });
    const loginA = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'owner@tenant-a.test', password: 'Sup3rSecretA!', businessSlug: 'tenant-a-e2e' });
    const branchesA = await request(app.getHttpServer())
      .get('/api/v1/branches')
      .set('Authorization', `Bearer ${loginA.body.data.accessToken}`);
    bizA = {
      id: regA.body.data.businessId,
      token: loginA.body.data.accessToken,
      branchId: branchesA.body.data[0].id,
    };

    const regB = await request(app.getHttpServer()).post('/api/v1/businesses/register').send({
      businessName: 'Tenant B',
      businessSlug: 'tenant-b-e2e',
      ownerName: 'Owner B',
      ownerEmail: 'owner@tenant-b.test',
      ownerPassword: 'Sup3rSecretB!',
    });
    const loginB = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'owner@tenant-b.test', password: 'Sup3rSecretB!', businessSlug: 'tenant-b-e2e' });
    const branchesB = await request(app.getHttpServer())
      .get('/api/v1/branches')
      .set('Authorization', `Bearer ${loginB.body.data.accessToken}`);
    bizB = {
      id: regB.body.data.businessId,
      token: loginB.body.data.accessToken,
      branchId: branchesB.body.data[0].id,
    };
  });

  afterAll(async () => {
    await admin.$disconnect();
    await appRoleClient.$disconnect();
    await app.close();
  });

  it('API layer: tenant B never sees tenant A branches in a list call', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/branches')
      .set('Authorization', `Bearer ${bizB.token}`)
      .expect(200);
    const ids: string[] = res.body.data.map((b: { id: string }) => b.id);
    expect(ids).not.toContain(bizA.branchId);
    expect(ids).toContain(bizB.branchId);
  });

  it('API layer: tenant B cannot update tenant A branch by guessing/reusing its id (404, not 200)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/branches/${bizA.branchId}`)
      .set('Authorization', `Bearer ${bizB.token}`)
      .send({ name: 'Hijacked' })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    const stillA = await admin.branch.findUniqueOrThrow({ where: { id: bizA.branchId } });
    expect(stillA.name).not.toBe('Hijacked');
  });

  it('DB layer: a raw query as the erp_app role with NO tenant context set returns zero rows, even with no WHERE clause', async () => {
    const rows = await appRoleClient.$queryRawUnsafe<unknown[]>('SELECT * FROM branches');
    expect(rows.length).toBe(0);
  });

  it('DB layer: setting tenant context to A returns ONLY A rows, never B, from an unfiltered query', async () => {
    const rows = await appRoleClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${bizA.id}'`);
      return tx.$queryRawUnsafe<{ business_id: string }[]>('SELECT business_id FROM branches');
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.business_id === bizA.id)).toBe(true);
  });

  it('DB layer: erp_app cannot write a row for tenant A while context is set to tenant B (RLS WITH CHECK rejects it)', async () => {
    await expect(
      appRoleClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${bizB.id}'`);
        await tx.$executeRawUnsafe(
          `INSERT INTO branches (id, business_id, name, updated_at) VALUES ('${randomUUID()}', '${bizA.id}', 'Smuggled Branch', NOW())`,
        );
      }),
    ).rejects.toThrow();

    const smuggled = await admin.branch.findFirst({ where: { name: 'Smuggled Branch' } });
    expect(smuggled).toBeNull();
  });

  it('DB layer: audit_logs is append-only - erp_app has no UPDATE/DELETE privilege at all', async () => {
    const anyAuditRow = await admin.auditLog.findFirstOrThrow();

    await expect(
      appRoleClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${bizA.id}'`);
        await tx.$executeRawUnsafe(`UPDATE audit_logs SET reason = 'tampered' WHERE id = '${anyAuditRow.id}'`);
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      appRoleClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${bizA.id}'`);
        await tx.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${anyAuditRow.id}'`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('DB layer: businesses cannot be hard-deleted by erp_app at all (no DELETE grant)', async () => {
    await expect(
      appRoleClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${bizA.id}'`);
        await tx.$executeRawUnsafe(`DELETE FROM businesses WHERE id = '${bizA.id}'`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});
