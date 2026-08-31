import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { registerAndLogin, RegisteredBusiness } from './utils/register-and-login';

/**
 * Phase 10 (10G) — password change and administrative reset.
 *
 * The claim that matters: A PASSWORD CHANGE ENDS EVERY LIVE SESSION.
 * Changing a password after a suspected compromise is theatre if a stolen
 * refresh token outlives the password it was minted under, so every
 * successful change revokes them all - including the one belonging to the
 * device that made the change.
 */
describe('Passwords: change and administrative reset (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: RegisteredBusiness;
  let seq = 0;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await registerAndLogin(app, 'passwords');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  /** A fresh CASHIER, logged in, with their tokens. */
  async function makeUser(password = 'RoleUserPass1!') {
    const role = await admin.role.findFirstOrThrow({ where: { businessId: biz.businessId, name: 'CASHIER' } });
    const email = `pw${seq++}@${biz.slug}.test`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: 'pw user', email, password, roleIds: [role.id], branchIds: [] })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, businessSlug: biz.slug })
      .expect(200);
    return {
      id: created.body.data.id as string,
      email,
      accessToken: login.body.data.accessToken as string,
      refreshToken: login.body.data.refreshToken as string,
    };
  }

  const login = (email: string, password: string) =>
    request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password, businessSlug: biz.slug });

  // ==================================================================
  describe('Changing your own password', () => {
    it('changes it, and the OLD password stops working while the new one starts', async () => {
      const user = await makeUser();

      await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ currentPassword: 'RoleUserPass1!', newPassword: 'BrandNewPass2@' })
        .expect(200);

      await login(user.email, 'RoleUserPass1!').expect(401);
      await login(user.email, 'BrandNewPass2@').expect(200);
    });

    it('REVOKES EVERY LIVE SESSION, including the one that made the change', async () => {
      const user = await makeUser();
      // A second device, signed in as the same person.
      const second = await login(user.email, 'RoleUserPass1!').expect(200);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ currentPassword: 'RoleUserPass1!', newPassword: 'BrandNewPass3@' })
        .expect(200);
      expect(res.body.data.revokedSessions).toBeGreaterThanOrEqual(2);

      // Neither refresh token survives. This is the whole point: a stolen
      // one must not outlive the password it was minted under.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: second.body.data.refreshToken })
        .expect(401);

      const live = await admin.refreshToken.count({ where: { userId: user.id, revokedAt: null } });
      expect(live).toBe(0);
    });

    it('refuses a wrong current password, and says nothing about which field was wrong', async () => {
      const user = await makeUser();
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ currentPassword: 'NotThePassword1!', newPassword: 'BrandNewPass4@' })
        .expect(422);
      expect(JSON.stringify(res.body)).toMatch(/current password is incorrect/i);

      // Unchanged, and no session was revoked on a failed attempt.
      await login(user.email, 'RoleUserPass1!').expect(200);
      expect(await admin.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBeGreaterThan(0);
    });

    it('refuses reusing the current password, and refuses a weak new one', async () => {
      const user = await makeUser();
      await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ currentPassword: 'RoleUserPass1!', newPassword: 'RoleUserPass1!' })
        .expect(422);
      await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ currentPassword: 'RoleUserPass1!', newPassword: 'short' })
        .expect(422);
    });

    it('needs no permission at all - every authenticated user may change their own', async () => {
      // A role with NOTHING in it but the bare minimum to exist.
      const role = await request(app.getHttpServer())
        .post('/api/v1/roles')
        .set('Authorization', auth())
        .send({ name: `Nobody ${seq++}`, permissionCodes: ['sales.view'] })
        .expect(201);
      const email = `nobody${seq}@${biz.slug}.test`;
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'nobody', email, password: 'RoleUserPass1!', roleIds: [role.body.data.id], branchIds: [] })
        .expect(201);
      const session = await login(email, 'RoleUserPass1!').expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${session.body.data.accessToken}`)
        .send({ currentPassword: 'RoleUserPass1!', newPassword: 'BrandNewPass5@' })
        .expect(200);
    });

    it('is not reachable without being signed in', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .send({ currentPassword: 'RoleUserPass1!', newPassword: 'BrandNewPass6@' })
        .expect(401);
    });
  });

  // ==================================================================
  describe('Administrative reset', () => {
    it('sets a new password without knowing the old one, and revokes that user everywhere', async () => {
      const user = await makeUser();

      const res = await request(app.getHttpServer())
        .post(`/api/v1/users/${user.id}/password`)
        .set('Authorization', auth())
        .send({ newPassword: 'OwnerSetPass7@' })
        .expect(200);
      expect(res.body.data.revokedSessions).toBeGreaterThanOrEqual(1);

      await login(user.email, 'RoleUserPass1!').expect(401);
      await login(user.email, 'OwnerSetPass7@').expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(401);
    });

    it('requires users.edit - a cashier cannot reset anybody, including themselves this way', async () => {
      const victim = await makeUser();
      const cashier = await makeUser();

      await request(app.getHttpServer())
        .post(`/api/v1/users/${victim.id}/password`)
        .set('Authorization', `Bearer ${cashier.accessToken}`)
        .send({ newPassword: 'Hijacked8@' })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/api/v1/users/${cashier.id}/password`)
        .set('Authorization', `Bearer ${cashier.accessToken}`)
        .send({ newPassword: 'Hijacked8@' })
        .expect(403);

      // Unchanged.
      await login(victim.email, 'RoleUserPass1!').expect(200);
    });

    it('cannot reach a user in ANOTHER tenant', async () => {
      const other = await registerAndLogin(app, `pwother${seq++}`);
      const otherOwner = await admin.user.findFirstOrThrow({ where: { businessId: other.businessId } });

      await request(app.getHttpServer())
        .post(`/api/v1/users/${otherOwner.id}/password`)
        .set('Authorization', auth())
        .send({ newPassword: 'CrossTenant9@' })
        .expect(404);

      // Their password is untouched - RLS made the row invisible, it did
      // not merely hide it from the response.
      const after = await admin.user.findUniqueOrThrow({ where: { id: otherOwner.id } });
      expect(after.passwordHash).toBe(otherOwner.passwordHash);
    });

    it('refuses to set a password on a SUSPENDED user - reactivate them first', async () => {
      const user = await makeUser();
      await request(app.getHttpServer())
        .patch(`/api/v1/users/${user.id}`)
        .set('Authorization', auth())
        .send({ status: 'SUSPENDED' })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/users/${user.id}/password`)
        .set('Authorization', auth())
        .send({ newPassword: 'Reactivated0@' })
        .expect(409);
    });
  });

  // ==================================================================
  it('NEVER writes the password or its hash into the audit trail', async () => {
    const user = await makeUser('AuditSecret1!');
    await request(app.getHttpServer())
      .post('/api/v1/auth/password')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ currentPassword: 'AuditSecret1!', newPassword: 'AuditSecret2@' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/users/${user.id}/password`)
      .set('Authorization', auth())
      .send({ newPassword: 'AuditSecret3@' })
      .expect(200);

    const logs = await admin.auditLog.findMany({ where: { businessId: biz.businessId, entityId: user.id } });
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const dump = JSON.stringify(logs);
    for (const secret of ['AuditSecret1!', 'AuditSecret2@', 'AuditSecret3@', 'passwordHash', '$argon2']) {
      expect(dump).not.toContain(secret);
    }
  });
});
