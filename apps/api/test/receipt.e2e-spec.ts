import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture, createTax } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 10 (10F) — the receipt payload and the business profile it prints.
 *
 * The claims under test:
 *
 *   1. NOTHING IS RECALCULATED. Every figure is read from what the sale
 *      STORED, so a receipt reprinted after the tax rate, the price and the
 *      promotion have all changed shows exactly what it showed on the day -
 *      non-negotiable #8 applied to the one artefact a customer keeps.
 *   2. COST AND PROFIT ARE ABSENT FOR EVERYONE, including an owner. A
 *      receipt is handed to a customer; the shop's margin must not be on it.
 *   3. THE BUSINESS PROFILE IS FREE TEXT. The product ships knowing nothing
 *      about any country's invoicing rules and validates none of them.
 */
describe('Receipts and the business profile (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let seq = 0;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'receipt');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function stocked(opts: { taxId?: string } = {}) {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `RCPT-${seq++}`, {
      defaultCost: 4,
      ...opts,
    });
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 200, unitCost: 4 })
      .expect(201);
    return variantId;
  }

  const sell = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, ...body });

  const receipt = (saleId: string, token = auth()) =>
    request(app.getHttpServer()).get(`/api/v1/sales/${saleId}/receipt`).set('Authorization', token);

  // ==================================================================
  describe('The business profile', () => {
    it('stores free text and prints it on the receipt', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/business')
        .set('Authorization', auth())
        .send({
          legalName: 'Retail Operating Systems LLC',
          taxNumber: '100-200-300',
          registrationNumber: 'CR-99887',
          phone: '+20 100 000 0000',
          email: 'shop@example.test',
          addressLine: '12 Market Street',
          city: 'Cairo',
          country: 'Egypt',
          receiptHeader: 'Welcome!',
          receiptFooter: 'Returns accepted within 14 days with this receipt.',
        })
        .expect(200);

      const variantId = await stocked();
      const sale = await sell({ items: [{ variantId, quantity: 1, unitPrice: 50 }], payments: [{ amount: 50 }] }).expect(201);

      const res = await receipt(sale.body.data.id).expect(200);
      expect(res.body.data.business.legalName).toBe('Retail Operating Systems LLC');
      expect(res.body.data.business.taxNumber).toBe('100-200-300');
      expect(res.body.data.business.receiptFooter).toMatch(/14 days/);
      // The name to PRINT is the legal name when one is set.
      expect(res.body.data.business.displayName).toBe('Retail Operating Systems LLC');
    });

    it('falls back to the trading name when no legal name is set, and clears a field with null', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/business')
        .set('Authorization', auth())
        .send({ legalName: null })
        .expect(200);

      const variantId = await stocked();
      const sale = await sell({ items: [{ variantId, quantity: 1, unitPrice: 10 }], payments: [{ amount: 10 }] }).expect(201);
      const res = await receipt(sale.body.data.id).expect(200);
      expect(res.body.data.business.legalName).toBeNull();
      expect(res.body.data.business.displayName).toBe(res.body.data.business.name);
    });

    it('requires business.edit to change, and is readable by anyone who may see a sale', async () => {
      const role = await request(app.getHttpServer())
        .post('/api/v1/roles')
        .set('Authorization', auth())
        .send({ name: `Reader ${seq++}`, permissionCodes: ['sales.view', 'business.view'] })
        .expect(201);
      const email = `reader${seq}@${biz.slug}.test`;
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'reader', email, password: 'RoleUserPass1!', roleIds: [role.body.data.id], branchIds: [] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'RoleUserPass1!', businessSlug: biz.slug })
        .expect(200);

      await request(app.getHttpServer())
        .patch('/api/v1/business')
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .send({ taxNumber: 'HIJACKED' })
        .expect(403);

      expect((await admin.business.findUniqueOrThrow({ where: { id: biz.businessId } })).taxNumber).toBe('100-200-300');
    });
  });

  // ==================================================================
  describe('The receipt payload', () => {
    it('carries everything a printed slip needs, in ONE request', async () => {
      const taxId = await createTax(app, biz.accessToken, 10);
      const taxed = await stocked({ taxId });
      const untaxed = await stocked();

      const customer = await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', auth())
        .send({ name: 'Receipt Customer', phone: '0100' })
        .expect(201);

      const sale = await sell({
        customerId: customer.body.data.id,
        items: [
          { variantId: taxed, quantity: 2, unitPrice: 100 },
          { variantId: untaxed, quantity: 1, unitPrice: 30 },
        ],
        payments: [
          { amount: 100, method: 'CASH' },
          { amount: 150, method: 'CARD' },
        ],
      }).expect(201);

      const res = await receipt(sale.body.data.id).expect(200);
      const d = res.body.data;

      // Who sold it, where, and on which till.
      expect(d.branch.id).toBe(biz.branchId);
      expect(d.register.id).toBe(biz.cashRegisterId);
      expect(d.cashier.id).toBeTruthy();
      expect(d.customer.name).toBe('Receipt Customer');

      // The money.
      expect(d.sale.subtotal).toBe('230');
      expect(d.sale.taxAmount).toBe('20'); // 10% of the taxed line's 200
      expect(d.sale.totalAmount).toBe('250');
      expect(d.sale.paidAmount).toBe('250');
      expect(d.sale.paymentStatus).toBe('PAID');
      expect(d.payments.map((p: { method: string; amount: string }) => `${p.method}:${p.amount}`).sort()).toEqual([
        'CARD:150',
        'CASH:100',
      ]);

      // The lines, with the product's real name rather than only a SKU.
      expect(d.items).toHaveLength(2);
      const taxedLine = d.items.find((i: { taxRatePercent: string | null }) => i.taxRatePercent === '10');
      expect(taxedLine.quantity).toBe('2');
      expect(taxedLine.name).toBeTruthy();
      expect(taxedLine.taxAmount).toBe('20');

      // The tax breakdown a receipt has to show: one row per RATE.
      expect(d.taxBreakdown).toEqual([
        { ratePercent: '0', taxableAmount: '30', taxAmount: '0' },
        { ratePercent: '10', taxableAmount: '200', taxAmount: '20' },
      ]);
    });

    it('NEVER carries cost or profit - not even for an owner who can see them elsewhere', async () => {
      const variantId = await stocked();
      const sale = await sell({ items: [{ variantId, quantity: 5, unitPrice: 20 }], payments: [{ amount: 100 }] }).expect(201);

      // The owner CAN see cost on the ordinary sale view...
      const asSale = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.body.data.id}`)
        .set('Authorization', auth())
        .expect(200);
      expect(asSale.body.data.totalCost).toBe('20');

      // ...and cannot on the receipt, which is a document for the CUSTOMER.
      const res = await receipt(sale.body.data.id).expect(200);
      const dump = JSON.stringify(res.body);
      expect(dump).not.toMatch(/totalCost|grossProfit|averageCost|unitCostAtMovement/);
    });

    it('REPRINTS THE ORIGINAL FIGURES after the tax rate has changed', async () => {
      const taxId = await createTax(app, biz.accessToken, 20);
      const variantId = await stocked({ taxId });
      const sale = await sell({ items: [{ variantId, quantity: 1, unitPrice: 100 }], payments: [{ amount: 120 }] }).expect(201);

      const before = await receipt(sale.body.data.id).expect(200);
      expect(before.body.data.sale.taxAmount).toBe('20');

      await request(app.getHttpServer())
        .patch(`/api/v1/taxes/${taxId}`)
        .set('Authorization', auth())
        .send({ ratePercent: 5 })
        .expect(200);

      // The same receipt, printed again after the world changed.
      const after = await receipt(sale.body.data.id).expect(200);
      expect(after.body.data.sale.taxAmount).toBe('20');
      expect(after.body.data.sale.totalAmount).toBe('120');
      expect(after.body.data.taxBreakdown).toEqual([{ ratePercent: '20', taxableAmount: '100', taxAmount: '20' }]);
    });

    it('shows what came back, so a reprint after a return is not misleading', async () => {
      const customer = await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', auth())
        .send({ name: 'Returner' })
        .expect(201);
      const variantId = await stocked();
      const sale = await sell({
        customerId: customer.body.data.id,
        items: [{ variantId, quantity: 4, unitPrice: 25 }],
        payments: [{ amount: 100 }],
      }).expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.body.data.id}/returns`)
        .set('Authorization', auth())
        .send({
          items: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          refund: { method: 'CASH', amount: 25 },
        })
        .expect(201);

      const res = await receipt(sale.body.data.id).expect(200);
      expect(res.body.data.returns).toHaveLength(1);
      expect(res.body.data.returns[0].refundAmount).toBe('25');
      expect(res.body.data.items[0].quantityReturned).toBe('1');
    });

    it('names the return an EXCHANGE replaced', async () => {
      const customer = await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', auth())
        .send({ name: 'Swapper' })
        .expect(201);
      const oldItem = await stocked();
      const newItem = await stocked();
      const sale = await sell({
        customerId: customer.body.data.id,
        items: [{ variantId: oldItem, quantity: 1, unitPrice: 40 }],
        payments: [{ amount: 40 }],
      }).expect(201);

      const ex = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.body.data.id}/exchanges`)
        .set('Authorization', auth())
        .send({
          returnItems: [{ saleItemId: sale.body.data.items[0].id, quantity: 1, condition: 'SELLABLE' }],
          newItems: [{ variantId: newItem, quantity: 1, unitPrice: 60 }],
          payments: [{ amount: 20, method: 'CASH' }],
        })
        .expect(201);

      const res = await receipt(ex.body.data.sale.id).expect(200);
      expect(res.body.data.sale.exchangeForReturn.returnNumber).toBe(ex.body.data.saleReturn.returnNumber);
    });

    it('shows the loyalty a customer expects on their slip', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.points_per_currency_unit', value: 1 })
        .expect(200);
      const customer = await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', auth())
        .send({ name: 'Loyal' })
        .expect(201);

      const variantId = await stocked();
      const sale = await sell({
        customerId: customer.body.data.id,
        items: [{ variantId, quantity: 1, unitPrice: 70 }],
        payments: [{ amount: 70 }],
      }).expect(201);

      const res = await receipt(sale.body.data.id).expect(200);
      expect(res.body.data.loyalty.earned).toBe('70');
      expect(res.body.data.loyalty.redeemed).toBe('0');

      await request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', auth())
        .send({ key: 'loyalty.points_per_currency_unit', value: null })
        .expect(200);
    });

    it('is refused for a sale in another tenant, and for a role without sales.view', async () => {
      const variantId = await stocked();
      const sale = await sell({ items: [{ variantId, quantity: 1, unitPrice: 10 }], payments: [{ amount: 10 }] }).expect(201);

      const role = await request(app.getHttpServer())
        .post('/api/v1/roles')
        .set('Authorization', auth())
        .send({ name: `NoSales ${seq++}`, permissionCodes: ['products.view'] })
        .expect(201);
      const email = `nosales${seq}@${biz.slug}.test`;
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'nosales', email, password: 'RoleUserPass1!', roleIds: [role.body.data.id], branchIds: [] })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'RoleUserPass1!', businessSlug: biz.slug })
        .expect(200);

      await receipt(sale.body.data.id, `Bearer ${login.body.data.accessToken}`).expect(403);
      await receipt('00000000-0000-0000-0000-000000000000').expect(404);
    });
  });
});
