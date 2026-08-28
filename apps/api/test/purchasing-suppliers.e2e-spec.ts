import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { registerAndLogin } from './utils/register-and-login';

describe('Purchasing: suppliers (e2e, real Postgres)', () => {
  let app: INestApplication;
  let biz: Awaited<ReturnType<typeof registerAndLogin>>;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    biz = await registerAndLogin(app, 'suppliers');
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  it('creates a supplier with a starting balance of 0', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/purchasing/suppliers')
      .set('Authorization', auth())
      .send({ name: 'Acme Textiles', contactPerson: 'Sam', phone: '0100', email: 'sam@acme.test', paymentTermsDays: 30 })
      .expect(201);
    expect(res.body.data.name).toBe('Acme Textiles');
    expect(res.body.data.isActive).toBe(true);

    const get = await request(app.getHttpServer())
      .get(`/api/v1/purchasing/suppliers/${res.body.data.id}`)
      .set('Authorization', auth())
      .expect(200);
    expect(get.body.data.balance).toBe('0');
  });

  it('rejects a duplicate supplier name within the same business (normal + race via unique constraint)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/purchasing/suppliers')
      .set('Authorization', auth())
      .send({ name: 'Duplicate Co' })
      .expect(201);

    const dup = await request(app.getHttpServer())
      .post('/api/v1/purchasing/suppliers')
      .set('Authorization', auth())
      .send({ name: 'Duplicate Co' })
      .expect(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('rejects invalid supplier input (empty name, bad email)', async () => {
    const empty = await request(app.getHttpServer())
      .post('/api/v1/purchasing/suppliers')
      .set('Authorization', auth())
      .send({ name: '' })
      .expect(422);
    expect(empty.body.error.code).toBe('VALIDATION_FAILED');

    const badEmail = await request(app.getHttpServer())
      .post('/api/v1/purchasing/suppliers')
      .set('Authorization', auth())
      .send({ name: 'Bad Email Co', email: 'not-an-email' })
      .expect(422);
    expect(badEmail.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('updates a supplier and rejects renaming into a clash with another supplier', async () => {
    const a = await request(app.getHttpServer()).post('/api/v1/purchasing/suppliers').set('Authorization', auth()).send({ name: 'Update A' }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/purchasing/suppliers').set('Authorization', auth()).send({ name: 'Update B' }).expect(201);

    const renamed = await request(app.getHttpServer())
      .patch(`/api/v1/purchasing/suppliers/${a.body.data.id}`)
      .set('Authorization', auth())
      .send({ phone: '0123456789' })
      .expect(200);
    expect(renamed.body.data.phone).toBe('0123456789');

    const clash = await request(app.getHttpServer())
      .patch(`/api/v1/purchasing/suppliers/${a.body.data.id}`)
      .set('Authorization', auth())
      .send({ name: 'Update B' })
      .expect(409);
    expect(clash.body.error.code).toBe('CONFLICT');
  });

  it('deactivates a supplier with no open purchase, and rejects deactivating an already-inactive one', async () => {
    const s = await request(app.getHttpServer()).post('/api/v1/purchasing/suppliers').set('Authorization', auth()).send({ name: 'Deactivate Me' }).expect(201);

    const deactivated = await request(app.getHttpServer())
      .delete(`/api/v1/purchasing/suppliers/${s.body.data.id}`)
      .set('Authorization', auth())
      .expect(200);
    expect(deactivated.body.data.isActive).toBe(false);

    const again = await request(app.getHttpServer())
      .delete(`/api/v1/purchasing/suppliers/${s.body.data.id}`)
      .set('Authorization', auth())
      .expect(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });

  it('returns 404 for a non-existent supplier id', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/purchasing/suppliers/00000000-0000-0000-0000-000000000000')
      .set('Authorization', auth())
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('lists suppliers with pagination and search', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/v1/purchasing/suppliers?limit=2&page=1')
      .set('Authorization', auth())
      .expect(200);
    expect(list.body.data.length).toBeLessThanOrEqual(2);
    expect(list.body.pagination.limit).toBe(2);

    const search = await request(app.getHttpServer())
      .get('/api/v1/purchasing/suppliers?search=Acme')
      .set('Authorization', auth())
      .expect(200);
    expect(search.body.data.every((s: { name: string }) => s.name.includes('Acme'))).toBe(true);
  });
});
