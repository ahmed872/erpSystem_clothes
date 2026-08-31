import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { resetDatabase } from './db-reset';

/**
 * Phase 11 — the limits on the endpoints that actually get attacked.
 *
 * WHY THIS SPEC BUILDS ITS OWN APPLICATION. `.env.test` raises every rate
 * limit to 100,000 so the rest of the suite - which registers hundreds of
 * businesses and signs in constantly - tests what it means to test rather
 * than throttling itself. That makes the relaxed limits the ONLY thing the
 * other specs prove about throttling, which is nothing. Here the limits
 * are set to small numbers BEFORE the application module is loaded (the
 * policy reads them at import time), so the application under test is
 * wired with production-shaped limits and the guard can be shown to be
 * real.
 *
 * The counters are per handler, per IP, in memory, with a one-minute
 * window - so each block below reasons about its OWN endpoint's budget and
 * asserts the refusal arrives at or before the configured limit, rather
 * than pinning an exact attempt number that a shared window could shift.
 */
const LOGIN_LIMIT = 5;
const REGISTRATION_LIMIT = 4;
const CREDENTIAL_LIMIT = 6;

describe('Phase 11: rate limiting (e2e, real Postgres)', () => {
  let app: INestApplication;
  let slug: string;
  let email: string;
  let refreshToken: string;
  let accessToken: string;
  const password = 'Sup3rSecret!';

  beforeAll(async () => {
    await resetDatabase();

    // BEFORE the module graph is loaded: `throttle-policy.ts` reads these
    // when the decorators run, which is at import time.
    process.env.RATE_LIMIT_GLOBAL = '5000';
    process.env.RATE_LIMIT_LOGIN = String(LOGIN_LIMIT);
    process.env.RATE_LIMIT_REGISTRATION = String(REGISTRATION_LIMIT);
    process.env.RATE_LIMIT_CREDENTIAL = String(CREDENTIAL_LIMIT);

    // Dynamic imports, deliberately: a static `import` is hoisted above
    // the assignments above, and the policy would then read the relaxed
    // limits from `.env.test` instead of the ones set here.
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module');
    const { AllExceptionsFilter } = await import('../src/common/filters/all-exceptions.filter');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    app.setGlobalPrefix('api/v1');
    await app.init();

    slug = `rl-${Date.now()}`;
    email = `owner@${slug}.test`;
    await request(app.getHttpServer())
      .post('/api/v1/businesses/register')
      .send({ businessName: 'Rate Limits', businessSlug: slug, ownerName: 'Owner', ownerEmail: email, ownerPassword: password })
      .expect(201);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, businessSlug: slug })
      .expect(200);
    accessToken = login.body.data.accessToken;
    refreshToken = login.body.data.refreshToken;
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Calls `attempt` until it returns 429, and reports the 1-based attempt
   * number that was refused (or -1 if the budget was never exhausted).
   */
  async function firstRefusal(attempt: (n: number) => Promise<number>, maxAttempts: number): Promise<number> {
    for (let n = 1; n <= maxAttempts; n += 1) {
      if ((await attempt(n)) === 429) return n;
    }
    return -1;
  }

  // ==================================================================
  it('REFUSES a burst of sign-in attempts, wrong password or right', async () => {
    // Wrong passwords are what a dictionary attack sends, so they must
    // consume the budget - a limit that only counted successes would stop
    // nothing at all.
    const refused = await firstRefusal(async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'WrongPassword1', businessSlug: slug });
      return res.status;
    }, LOGIN_LIMIT + 2);

    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThanOrEqual(LOGIN_LIMIT + 1);

    // And the CORRECT credentials are refused too, once the budget is
    // spent: the limit is on the source, not on whether it guessed right.
    const correct = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, businessSlug: slug })
      .expect(429);
    expect(correct.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(correct.body.error.requestId).toBeTruthy();
  });

  it('REFUSES bulk tenant creation - the one endpoint that makes top-level data with no credential', async () => {
    const refused = await firstRefusal(async (n) => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/businesses/register')
        .send({
          businessName: `Bulk ${n}`,
          businessSlug: `${slug}-bulk-${n}`,
          ownerName: 'Owner',
          ownerEmail: `bulk${n}@${slug}.test`,
          ownerPassword: password,
        });
      return res.status;
    }, REGISTRATION_LIMIT + 2);

    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThanOrEqual(REGISTRATION_LIMIT + 1);
  });

  it('REFUSES a stolen refresh token being exercised in a loop', async () => {
    const refused = await firstRefusal(async () => {
      const res = await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken });
      // Rotation means only the first call can succeed; every later one is
      // a 401 that still costs budget, which is exactly the behaviour that
      // caps how fast a leaked token can be ground.
      if (res.status === 200) refreshToken = res.body.data.refreshToken;
      return res.status;
    }, CREDENTIAL_LIMIT + 2);

    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThanOrEqual(CREDENTIAL_LIMIT + 1);
  });

  it('REFUSES a password-change loop grinding the currentPassword check', async () => {
    const refused = await firstRefusal(async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: 'GuessGuessGuess1!', newPassword: 'WhateverPass2@' });
      return res.status;
    }, CREDENTIAL_LIMIT + 2);

    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThanOrEqual(CREDENTIAL_LIMIT + 1);
  });

  it('does NOT tighten the ordinary API - a busy till is not an attack', async () => {
    // Far more calls than the login budget, on an authenticated endpoint,
    // all served. Throttling a cashier who scans quickly would be a real
    // operational cost for no security gain.
    for (let i = 0; i < LOGIN_LIMIT * 6; i += 1) {
      await request(app.getHttpServer())
        .get('/api/v1/branches')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    }
  });

});
