import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { registerAndLogin } from './utils/register-and-login';

describe('Sales: customers (e2e, real Postgres)', () => {
  let app: INestApplication;
  let biz: Awaited<ReturnType<typeof registerAndLogin>>;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    biz = await registerAndLogin(app, 'sales-customers');
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  it('creates a customer with a starting balance of 0', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales/customers')
      .set('Authorization', auth())
      .send({ name: 'Amina Hassan', phone: '0100000001', email: 'amina@example.test' })
      .expect(201);
    expect(res.body.data.name).toBe('Amina Hassan');
    expect(res.body.data.isActive).toBe(true);

    const get = await request(app.getHttpServer()).get(`/api/v1/sales/customers/${res.body.data.id}`).set('Authorization', auth()).expect(200);
    expect(get.body.data.balance).toBe('0');
  });

  it('allows two customers with the same name (no uniqueness constraint - real-world duplicate names are legitimate)', async () => {
    await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: 'Mohamed Ali' }).expect(201);
    const second = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: 'Mohamed Ali' }).expect(201);
    expect(second.body.data.name).toBe('Mohamed Ali');
  });

  it('rejects invalid customer input (empty name, bad email)', async () => {
    const empty = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: '' }).expect(422);
    expect(empty.body.error.code).toBe('VALIDATION_FAILED');

    const badEmail = await request(app.getHttpServer())
      .post('/api/v1/sales/customers')
      .set('Authorization', auth())
      .send({ name: 'Bad Email', email: 'not-an-email' })
      .expect(422);
    expect(badEmail.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('updates and deactivates a customer, and rejects double-deactivation', async () => {
    const c = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: 'Update Me' }).expect(201);

    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/sales/customers/${c.body.data.id}`)
      .set('Authorization', auth())
      .send({ phone: '0111111111' })
      .expect(200);
    expect(updated.body.data.phone).toBe('0111111111');

    const deactivated = await request(app.getHttpServer()).delete(`/api/v1/sales/customers/${c.body.data.id}`).set('Authorization', auth()).expect(200);
    expect(deactivated.body.data.isActive).toBe(false);

    const again = await request(app.getHttpServer()).delete(`/api/v1/sales/customers/${c.body.data.id}`).set('Authorization', auth()).expect(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });

  it('returns 404 for a non-existent customer id', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/sales/customers/00000000-0000-0000-0000-000000000000')
      .set('Authorization', auth())
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('lists customers with pagination and search', async () => {
    const list = await request(app.getHttpServer()).get('/api/v1/sales/customers?limit=2&page=1').set('Authorization', auth()).expect(200);
    expect(list.body.data.length).toBeLessThanOrEqual(2);
    expect(list.body.pagination.limit).toBe(2);

    const search = await request(app.getHttpServer()).get('/api/v1/sales/customers?search=Amina').set('Authorization', auth()).expect(200);
    expect(search.body.data.every((c: { name: string }) => c.name.includes('Amina'))).toBe(true);
  });
});
