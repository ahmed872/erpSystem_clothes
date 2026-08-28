import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';

describe('Auth: login / refresh / logout (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let businessId: string;

  const slug = 'auth-e2e-biz';
  const email = 'owner@auth-e2e.test';
  const password = 'Sup3rSecret!';

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    const res = await request(app.getHttpServer()).post('/api/v1/businesses/register').send({
      businessName: 'Auth E2E Biz',
      businessSlug: slug,
      ownerName: 'Owner',
      ownerEmail: email,
      ownerPassword: password,
    });
    businessId = res.body.data.businessId;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('rejects login with the wrong password and does not reveal which field was wrong', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'WrongPassword1', businessSlug: slug })
      .expect(401);
    expect(res.body.error.message).toBe('Invalid email or password');

    const failedAudit = await admin.auditLog.findFirst({
      where: { businessId, action: 'LOGIN_FAILED', reason: 'bad_password' },
    });
    expect(failedAudit).not.toBeNull();
  });

  it('rejects login for an unknown business slug with the same generic message (no tenant enumeration)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, businessSlug: 'no-such-business' })
      .expect(401);
    expect(res.body.error.message).toBe('Invalid email or password');
  });

  it('logs in successfully and returns a working access token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, businessSlug: slug })
      .expect(200);

    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();

    await request(app.getHttpServer())
      .get('/api/v1/business')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .expect(200);

    const loginAudit = await admin.auditLog.findFirst({ where: { businessId, action: 'LOGIN' } });
    expect(loginAudit).not.toBeNull();
  });

  it('rotates refresh tokens and rejects reuse of a token already consumed', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, businessSlug: slug })
      .expect(200);
    const firstRefresh = login.body.data.refreshToken;

    const rotated = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: firstRefresh })
      .expect(200);
    expect(rotated.body.data.accessToken).toBeTruthy();
    expect(rotated.body.data.refreshToken).not.toBe(firstRefresh);

    // Replaying the already-rotated (now revoked) token must fail.
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: firstRefresh }).expect(401);
  });

  it('logout revokes the refresh token so it can no longer be used', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, businessSlug: slug })
      .expect(200);
    const { accessToken, refreshToken } = login.body.data;

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken })
      .expect(204);

    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken }).expect(401);
  });

  it('rejects a suspended user even with a still-valid access token (fresh permission/status check per request)', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, businessSlug: slug })
      .expect(200);
    const { accessToken } = login.body.data;

    // Directly flip status via the admin connection to simulate a
    // concurrent suspension while the access token is still unexpired.
    const user = await admin.user.findFirstOrThrow({ where: { businessId, email } });
    await admin.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });

    await request(app.getHttpServer())
      .get('/api/v1/branches')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);

    await admin.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
  });
});
