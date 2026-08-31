import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase, assertSafeToTruncate } from './db-reset';
import { registerAndLogin, RegisteredBusiness } from './utils/register-and-login';
import { buildOpenApiDocument } from '../src/common/openapi/setup-swagger';
import { PERMISSIONS_KEY } from '../src/common/decorators/require-permissions.decorator';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';

/**
 * Phase 11 — the security and operations hardening, proved.
 *
 * Every block below exists because a REAL gap was found in the live code,
 * not because the category sounded worth covering. Nothing here restates
 * an invariant an earlier phase already proves at length: RLS, tenant
 * isolation and append-only enforcement have their own suites, and are
 * touched here only where Phase 11 opened a NEW path to them - the audit
 * read endpoint and the audit rows the guard now writes.
 */
describe('Phase 11: security hardening (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let appRole: PrismaClient;
  let biz: RegisteredBusiness;
  let other: RegisteredBusiness;
  let seq = 0;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    appRole = new PrismaClient({ datasources: { db: { url: process.env.RUNTIME_DATABASE_URL } } });
    biz = await registerAndLogin(app, 'sec');
    other = await registerAndLogin(app, 'sec-other');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await appRole.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  /** A fresh user on `biz` holding exactly one role, logged in. */
  async function makeUser(roleName: string) {
    const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: roleName } });
    const email = `sec${seq++}@${biz.slug}.test`;
    const password = 'RoleUserPass1!';
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: `sec ${roleName}`, email, password, roleIds: [role.id], branchIds: [] })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, businessSlug: biz.slug })
      .expect(200);
    return {
      id: created.body.data.id as string,
      email,
      password,
      accessToken: login.body.data.accessToken as string,
      refreshToken: login.body.data.refreshToken as string,
    };
  }

  // ==================================================================
  // THE RESET GUARD.
  //
  // `resetDatabase()` TRUNCATEs every table as the owner role, reading its
  // target from an environment variable, and had nothing standing between
  // it and a production connection string. These are pure function calls -
  // no database is touched - which is the whole point: the guard must
  // refuse BEFORE it connects.
  // ==================================================================
  describe('The database reset guard', () => {
    const productionUrl = 'postgresql://erp:hunter2@db.internal:5432/erp_production?schema=public';

    it('accepts the real test database under NODE_ENV=test', () => {
      expect(process.env.NODE_ENV).toBe('test');
      expect(() => assertSafeToTruncate(process.env.DATABASE_URL)).not.toThrow();
    });

    it('REFUSES a production database name even under NODE_ENV=test', () => {
      expect(() => assertSafeToTruncate(productionUrl)).toThrow(/does not identify it as a test database/);
    });

    it('REFUSES the test database itself when NODE_ENV is not test', () => {
      const original = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        expect(() => assertSafeToTruncate(process.env.DATABASE_URL)).toThrow(/NODE_ENV is "production"/);
        process.env.NODE_ENV = undefined as unknown as string;
        delete process.env.NODE_ENV;
        expect(() => assertSafeToTruncate('postgresql://x@y:5432/erp_test')).toThrow(/NODE_ENV is "unset"/);
      } finally {
        process.env.NODE_ENV = original;
      }
    });

    it('refuses an unset or unparseable target', () => {
      expect(() => assertSafeToTruncate(undefined)).toThrow(/DATABASE_URL is not set/);
      expect(() => assertSafeToTruncate('not-a-url')).toThrow(/not a parseable URL/);
    });

    it('NEVER puts the connection string - and therefore the password - in the error', () => {
      let message = '';
      try {
        assertSafeToTruncate(productionUrl);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain(productionUrl);
      // It still names the database, which is what an operator needs.
      expect(message).toContain('erp_production');
    });
  });

  // ==================================================================
  // REFRESH TOKEN REUSE.
  //
  // Rotation on its own only invalidates the token that was spent. It says
  // nothing about the copy an attacker took: they present it, are told
  // "invalid", and the session they stole it from carries on working. The
  // second presentation of an already-spent token is the one unambiguous
  // signal that a token leaked, and it is now treated as one.
  // ==================================================================
  describe('Refresh token reuse detection', () => {
    const refresh = (token: string) =>
      request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: token });

    it('rotates normally, and the spent token alone stops working', async () => {
      const user = await makeUser('CASHIER');
      const rotated = await refresh(user.refreshToken).expect(200);
      expect(rotated.body.data.refreshToken).not.toBe(user.refreshToken);

      // The new one works; nothing has been revoked.
      await refresh(rotated.body.data.refreshToken).expect(200);
    });

    it('REVOKES EVERY LIVE SESSION when a spent token is presented a second time', async () => {
      const user = await makeUser('CASHIER');
      // A second device for the same person, with its own live token.
      const second = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password, businessSlug: biz.slug })
        .expect(200);
      const secondToken: string = second.body.data.refreshToken;

      const rotated = await refresh(user.refreshToken).expect(200);
      const liveToken: string = rotated.body.data.refreshToken;

      // The leak: the original token, already spent, presented again.
      const reused = await refresh(user.refreshToken).expect(401);
      expect(reused.body.error.message).toBe('Invalid or expired refresh token');

      // Both surviving sessions are now dead - the one rotated out of the
      // stolen token, and the unrelated second device.
      await refresh(liveToken).expect(401);
      await refresh(secondToken).expect(401);

      const live = await admin.refreshToken.count({ where: { userId: user.id, revokedAt: null } });
      expect(live).toBe(0);
    });

    it('records the reuse in the audit trail, naming how many sessions it killed', async () => {
      const user = await makeUser('CASHIER');
      await refresh(user.refreshToken).expect(200);
      await refresh(user.refreshToken).expect(401);

      const row = await admin.auditLog.findFirst({
        where: { businessId: biz.businessId, userId: user.id, entityType: 'RefreshToken' },
        orderBy: { createdAt: 'desc' },
      });
      expect(row).not.toBeNull();
      expect(row!.action).toBe('LOGIN_FAILED');
      expect(row!.reason).toMatch(/^refresh_token_reuse_detected: revoked \d+ live session\(s\)$/);
    });

    it('the audit row and the revocation SURVIVE, even though the request ends in a 401', async () => {
      // The trap this guards: throwing from inside the tenant transaction
      // would roll back both the revocation and the record of it, leaving
      // the attacker's session alive and no evidence anything happened.
      const user = await makeUser('CASHIER');
      const rotated = await refresh(user.refreshToken).expect(200);
      await refresh(user.refreshToken).expect(401);

      const [live, evidence] = await Promise.all([
        admin.refreshToken.count({ where: { userId: user.id, revokedAt: null } }),
        admin.auditLog.count({
          where: { userId: user.id, entityType: 'RefreshToken', reason: { startsWith: 'refresh_token_reuse_detected' } },
        }),
      ]);
      expect(live).toBe(0);
      expect(evidence).toBe(1);
      await refresh(rotated.body.data.refreshToken).expect(401);
    });

    it('a forged or unknown token is rejected WITHOUT revoking anything', async () => {
      const user = await makeUser('CASHIER');
      await refresh('not.a.token').expect(401);
      await refresh(`${user.refreshToken}tampered`).expect(401);

      // The genuine session is untouched: reuse detection must not be
      // triggerable by anyone who can send a bad string.
      await refresh(user.refreshToken).expect(200);
    });
  });

  // ==================================================================
  // SUSPENDED USERS.
  //
  // An access token lives for its full TTL. Suspending someone would be
  // worthless if their token kept working until it expired.
  // ==================================================================
  describe('Suspending a user', () => {
    it('kills their live access token, their refresh token, and any new login', async () => {
      const user = await makeUser('CASHIER');

      await request(app.getHttpServer())
        .get('/api/v1/sales')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      await request(app.getHttpServer()).delete(`/api/v1/users/${user.id}`).set('Authorization', auth()).expect(200);

      // The SAME token, unexpired, now refused - the permission set is
      // re-read from the database on every request rather than trusted
      // from the token.
      await request(app.getHttpServer())
        .get('/api/v1/sales')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(401);

      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(401);

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password, businessSlug: biz.slug })
        .expect(401);
    });
  });

  // ==================================================================
  // THE AUDIT TRAIL, READABLE.
  //
  // `audit.view` existed from Phase 1 and nothing served it: the record
  // was kept and could not be read through the API.
  // ==================================================================
  describe('Reading the audit trail', () => {
    const list = (token: string, query = '') =>
      request(app.getHttpServer()).get(`/api/v1/audit-logs${query}`).set('Authorization', `Bearer ${token}`);

    it('serves the trail to a holder of audit.view', async () => {
      const res = await list(biz.accessToken).expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.meta.total).toBeGreaterThan(0);
      expect(res.body.data[0]).toHaveProperty('action');
      expect(res.body.data[0]).toHaveProperty('businessId', biz.businessId);
    });

    it('refuses a Cashier - reading who did what is an oversight function, not a till function', async () => {
      const cashier = await makeUser('CASHIER');
      const denied = await list(cashier.accessToken).expect(403);
      expect(denied.body.error.message).toContain('audit.view');
    });

    it('refuses an unauthenticated caller outright', async () => {
      await request(app.getHttpServer()).get('/api/v1/audit-logs').expect(401);
    });

    it('NEVER shows another tenant a single row, however many pages are asked for', async () => {
      const mine = await list(biz.accessToken, '?limit=200').expect(200);
      const theirs = await list(other.accessToken, '?limit=200').expect(200);

      const myIds = new Set(mine.body.data.map((r: { id: string }) => r.id));
      const theirIds = new Set(theirs.body.data.map((r: { id: string }) => r.id));
      expect(theirs.body.data.length).toBeGreaterThan(0);
      for (const id of theirIds) expect(myIds.has(id)).toBe(false);
      for (const row of theirs.body.data) expect(row.businessId).toBe(other.businessId);

      // And the total is the tenant's own count, not the table's.
      const everything = await admin.auditLog.count();
      expect(theirs.body.meta.total).toBeLessThan(everything);
      expect(theirs.body.meta.total).toBe(
        await admin.auditLog.count({ where: { businessId: other.businessId } }),
      );
    });

    it('filters by action, entity and user', async () => {
      const logins = await list(biz.accessToken, '?action=LOGIN&limit=200').expect(200);
      expect(logins.body.data.length).toBeGreaterThan(0);
      for (const row of logins.body.data) expect(row.action).toBe('LOGIN');

      const byUser = await list(biz.accessToken, `?userId=${biz.ownerUserId}&limit=200`).expect(200);
      expect(byUser.body.data.length).toBeGreaterThan(0);
      for (const row of byUser.body.data) expect(row.userId).toBe(biz.ownerUserId);

      const byEntity = await list(biz.accessToken, '?entityType=User&limit=200').expect(200);
      for (const row of byEntity.body.data) expect(row.entityType).toBe('User');
    });

    it('pages DETERMINISTICALLY across rows written in the same transaction (same createdAt)', async () => {
      // Registration writes several rows at once, so `createdAt` alone is
      // not unique and paging on it would skip and repeat rows. This is
      // the regression that would catch losing the `id` tiebreak.
      const all = await list(biz.accessToken, '?limit=200').expect(200);
      const total: number = all.body.meta.total;
      expect(total).toBeGreaterThan(4);

      const seen: string[] = [];
      for (let page = 1; page <= Math.ceil(total / 3); page += 1) {
        const res = await list(biz.accessToken, `?limit=3&page=${page}`).expect(200);
        seen.push(...res.body.data.map((r: { id: string }) => r.id));
      }
      expect(seen.length).toBe(total);
      expect(new Set(seen).size).toBe(total);
      expect(seen).toEqual(all.body.data.map((r: { id: string }) => r.id));
    });

    it('rejects a malformed query rather than quietly ignoring it', async () => {
      await list(biz.accessToken, '?action=NOT_AN_ACTION').expect(422);
      await list(biz.accessToken, '?limit=9999').expect(422);
      await list(biz.accessToken, '?userId=not-a-uuid').expect(422);
    });

    it('exposes NO write verb, and the database would refuse one anyway', async () => {
      const doc = buildOpenApiDocument(app);
      expect(Object.keys(doc.paths['/api/v1/audit-logs'])).toEqual(['get']);

      // Belt and braces: `erp_app` holds SELECT and INSERT on the table,
      // so no endpoint could ever be added that edits or deletes a row.
      await expect(
        appRole.$executeRawUnsafe(`UPDATE audit_logs SET reason = 'tampered'`),
      ).rejects.toThrow(/permission denied/i);
      await expect(appRole.$executeRawUnsafe(`DELETE FROM audit_logs`)).rejects.toThrow(/permission denied/i);
      expect(await admin.auditLog.count({ where: { reason: 'tampered' } })).toBe(0);
    });
  });

  // ==================================================================
  // PERMISSION_DENIED.
  //
  // The enum value existed since Phase 1 and nothing wrote it, so "did
  // anyone try to reach the accounting module?" had no answer.
  // ==================================================================
  describe('Recording authorization failures', () => {
    it('writes a row naming the endpoint, the caller and the missing permission', async () => {
      const cashier = await makeUser('CASHIER');
      await request(app.getHttpServer())
        .get('/api/v1/accounting/accounts')
        .set('Authorization', `Bearer ${cashier.accessToken}`)
        .expect(403);

      const row = await admin.auditLog.findFirst({
        where: { businessId: biz.businessId, userId: cashier.id, action: 'PERMISSION_DENIED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(row).not.toBeNull();
      expect(row!.entityType).toBe('Endpoint');
      expect(row!.entityId).toContain('GET');
      expect(row!.entityId).toContain('accounting/accounts');
      expect(row!.reason).toMatch(/^missing: /);
    });

    it('records a denial per attempt, and the denial still stands', async () => {
      const cashier = await makeUser('CASHIER');
      for (let i = 0; i < 3; i += 1) {
        await request(app.getHttpServer())
          .post('/api/v1/branches')
          .set('Authorization', `Bearer ${cashier.accessToken}`)
          .send({ name: 'Nope', code: `NOPE${i}` })
          .expect(403);
      }
      const count = await admin.auditLog.count({
        where: { userId: cashier.id, action: 'PERMISSION_DENIED', entityId: { contains: 'branches' } },
      });
      expect(count).toBe(3);
      expect(await admin.branch.count({ where: { businessId: biz.businessId, name: 'Nope' } })).toBe(0);
    });

    it('files the denial under the CALLER’S tenant, where their own oversight can see it', async () => {
      const cashier = await makeUser('CASHIER');
      await request(app.getHttpServer())
        .get('/api/v1/accounting/journal-entries')
        .set('Authorization', `Bearer ${cashier.accessToken}`)
        .expect(403);

      const visible = await request(app.getHttpServer())
        .get('/api/v1/audit-logs?action=PERMISSION_DENIED&limit=200')
        .set('Authorization', auth())
        .expect(200);
      expect(visible.body.data.some((r: { userId: string }) => r.userId === cashier.id)).toBe(true);

      const theirs = await request(app.getHttpServer())
        .get('/api/v1/audit-logs?action=PERMISSION_DENIED&limit=200')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(200);
      expect(theirs.body.data.some((r: { userId: string }) => r.userId === cashier.id)).toBe(false);
    });

    it('leaves NO row when the request was allowed', async () => {
      const before = await admin.auditLog.count({ where: { action: 'PERMISSION_DENIED' } });
      await request(app.getHttpServer()).get('/api/v1/branches').set('Authorization', auth()).expect(200);
      expect(await admin.auditLog.count({ where: { action: 'PERMISSION_DENIED' } })).toBe(before);
    });
  });

  // ==================================================================
  // THE PUBLISHED CONTRACT.
  //
  // Documentation that is confidently wrong about authorization is worse
  // than none, so the document states the permissions read from the SAME
  // metadata the guard enforces - and this proves they agree.
  // ==================================================================
  describe('The OpenAPI document states the authorization that is actually enforced', () => {
    it('annotates every documented operation, and never contradicts the guard', () => {
      const doc = buildOpenApiDocument(app);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const container = (app as any).container;
      let checked = 0;

      for (const module of container.getModules().values()) {
        for (const wrapper of module.controllers.values()) {
          const controller = wrapper.metatype;
          if (!controller?.prototype) continue;
          for (const methodName of Object.getOwnPropertyNames(controller.prototype)) {
            if (methodName === 'constructor') continue;
            const handler = controller.prototype[methodName];
            if (typeof handler !== 'function') continue;
            const required: string[] =
              Reflect.getMetadata(PERMISSIONS_KEY, handler) ?? Reflect.getMetadata(PERMISSIONS_KEY, controller) ?? [];
            const isPublic: boolean =
              Reflect.getMetadata(IS_PUBLIC_KEY, handler) ?? Reflect.getMetadata(IS_PUBLIC_KEY, controller) ?? false;

            // Find the operation this handler produced, wherever it landed.
            const operations = Object.values(doc.paths)
              .flatMap((item) => Object.values(item as Record<string, { description?: string }>))
              .filter((op) => typeof op?.description === 'string');
            const match = operations.filter((op) =>
              isPublic
                ? op.description!.includes('**No authentication required.**')
                : required.length === 0
                  ? op.description!.includes('No additional permission.')
                  : op.description!.includes(required.map((c) => `\`${c}\``).join(', ')),
            );
            expect(match.length).toBeGreaterThan(0);
            checked += 1;
          }
        }
      }
      expect(checked).toBeGreaterThan(80);
    });

    it('documents the Phase 11 audit endpoint as requiring audit.view, and login as public', () => {
      const doc = buildOpenApiDocument(app);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const audit = (doc.paths['/api/v1/audit-logs'] as any).get;
      expect(audit.description).toContain('`audit.view`');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const login = (doc.paths['/api/v1/auth/login'] as any).post;
      expect(login.description).toContain('**No authentication required.**');
    });
  });
});
