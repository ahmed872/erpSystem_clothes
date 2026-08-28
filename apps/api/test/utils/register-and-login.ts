import { INestApplication } from '@nestjs/common';
import request from 'supertest';

export interface RegisteredBusiness {
  businessId: string;
  branchId: string;
  warehouseId: string;
  ownerUserId: string;
  ownerEmail: string;
  ownerPassword: string;
  slug: string;
  accessToken: string;
}

/** Registers a fresh business + logs in as its owner. Used by catalog e2e
 * specs, which each need their own isolated tenant to test against. */
export async function registerAndLogin(app: INestApplication, slugSuffix: string): Promise<RegisteredBusiness> {
  const slug = `catalog-${slugSuffix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const ownerEmail = `owner@${slug}.test`;
  const ownerPassword = 'Sup3rSecret!';

  const reg = await request(app.getHttpServer()).post('/api/v1/businesses/register').send({
    businessName: `Catalog Test ${slugSuffix}`,
    businessSlug: slug,
    ownerName: 'Owner',
    ownerEmail,
    ownerPassword,
  });
  if (reg.status !== 201) {
    throw new Error(`registerAndLogin: registration failed: ${JSON.stringify(reg.body)}`);
  }

  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: ownerEmail, password: ownerPassword, businessSlug: slug });
  if (login.status !== 200) {
    throw new Error(`registerAndLogin: login failed: ${JSON.stringify(login.body)}`);
  }

  return {
    businessId: reg.body.data.businessId,
    branchId: reg.body.data.branchId,
    warehouseId: reg.body.data.warehouseId,
    ownerUserId: reg.body.data.ownerUserId,
    ownerEmail,
    ownerPassword,
    slug,
    accessToken: login.body.data.accessToken,
  };
}
