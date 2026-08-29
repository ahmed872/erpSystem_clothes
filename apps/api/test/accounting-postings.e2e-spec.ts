import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Proves the exact debit/credit lines Phase 6 posts for every source
 * event, using real Postgres and the actual HTTP API end to end - not
 * mocks, and not just "an entry was created" but the precise accounts
 * and amounts. Also proves the three required reconciliations: COGS <->
 * StockMovement.unit_cost_at_movement, Customer subledger <-> AR, and
 * Supplier subledger <-> AP.
 */
describe('Accounting: exact postings and reconciliation (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;
  let supplierId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'acct-postings');

    const supplier = await request(app.getHttpServer())
      .post('/api/v1/purchasing/suppliers')
      .set('Authorization', auth())
      .send({ name: 'Acct Postings Supplier' })
      .expect(201);
    supplierId = supplier.body.data.id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  function auth() {
    return `Bearer ${biz.accessToken}`;
  }

  async function accountByCode(code: string) {
    const accounts = await request(app.getHttpServer()).get('/api/v1/accounting/accounts').set('Authorization', auth()).query({ limit: 200 }).expect(200);
    const account = accounts.body.data.find((a: { code: string }) => a.code === code);
    if (!account) throw new Error(`Account ${code} not found`);
    return account;
  }

  async function linesForSource(sourceType: string, sourceId: string) {
    const list = await request(app.getHttpServer()).get('/api/v1/accounting/journal-entries').set('Authorization', auth()).query({ sourceType, limit: 200 }).expect(200);
    const entry = list.body.data.find((e: { sourceId: string }) => e.sourceId === sourceId);
    if (!entry) throw new Error(`No journal entry found for ${sourceType}/${sourceId}`);
    return entry.lines as { accountId: string; debit: string; credit: string }[];
  }

  /** Sums debit (or credit) across every line for one account within one
   * entry - an account can legitimately appear more than once (e.g. a
   * DAMAGED return's two opposite Inventory legs). Compared as numbers,
   * not exact strings, since the API's Decimal JSON serialization
   * normalizes trailing zeros (e.g. "10" not "10.0000") - matching the
   * rest of this codebase's established API response convention. */
  function sumSide(lines: { accountId: string; debit: string; credit: string }[], accountId: string, side: 'debit' | 'credit') {
    return lines.filter((l) => l.accountId === accountId).reduce((sum, l) => sum + Number(l[side]), 0);
  }

  function lineCountFor(lines: { accountId: string; debit: string; credit: string }[], accountId: string) {
    return lines.filter((l) => l.accountId === accountId).length;
  }

  it('a fully-paid walk-in sale posts Dr Cash / Cr Revenue + Dr COGS / Cr Inventory, exactly', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ACCT-SALE-1');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 6 })
      .expect(201);

    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 3, unitPrice: 15, taxAmount: 3 }], payments: [{ amount: 48, method: 'CASH' }] })
      .expect(201);

    const cash = await accountByCode('1010');
    const revenue = await accountByCode('4100');
    const tax = await accountByCode('2200');
    const cogs = await accountByCode('5100');
    const inventory = await accountByCode('1200');

    const lines = await linesForSource('Sale', sale.body.data.id);
    expect(sumSide(lines, cash.id, 'debit')).toBe(48);
    expect(sumSide(lines, revenue.id, 'credit')).toBe(45);
    expect(sumSide(lines, tax.id, 'credit')).toBe(3);
    expect(sumSide(lines, cogs.id, 'debit')).toBe(18);
    expect(sumSide(lines, inventory.id, 'credit')).toBe(18);

    const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 4);
  });

  it('a credit sale posts Cash + Accounts Receivable split, and a later payment posts Dr Tender / Cr AR', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ACCT-SALE-2');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 4 })
      .expect(201);
    const customer = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: 'Credit Customer' }).expect(201);

    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, customerId: customer.body.data.id, items: [{ variantId, quantity: 2, unitPrice: 20 }], payments: [{ amount: 15, method: 'CARD' }] })
      .expect(201);

    const card = await accountByCode('1020');
    const ar = await accountByCode('1100');
    const revenue = await accountByCode('4100');

    const saleLines = await linesForSource('Sale', sale.body.data.id);
    expect(sumSide(saleLines, card.id, 'debit')).toBe(15);
    expect(sumSide(saleLines, ar.id, 'debit')).toBe(25);
    expect(sumSide(saleLines, revenue.id, 'credit')).toBe(40);

    const payment = await request(app.getHttpServer())
      .post(`/api/v1/sales/${sale.body.data.id}/payments`)
      .set('Authorization', auth())
      .send({ amount: 25, method: 'CASH' })
      .expect(201);

    const cash = await accountByCode('1010');
    const paymentLines = await linesForSource('SalePayment', payment.body.data.id);
    expect(sumSide(paymentLines, cash.id, 'debit')).toBe(25);
    expect(sumSide(paymentLines, ar.id, 'credit')).toBe(25);
  });

  it('a SELLABLE sale return reverses Revenue/COGS/Inventory/AR for a customer-attached sale', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ACCT-RET-1');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 5 })
      .expect(201);
    const customer = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: 'Return Customer' }).expect(201);
    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, customerId: customer.body.data.id, items: [{ variantId, quantity: 4, unitPrice: 10 }], payments: [{ amount: 40 }] })
      .expect(201);
    const saleItemId = sale.body.data.items[0].id;

    const ret = await request(app.getHttpServer())
      .post(`/api/v1/sales/${sale.body.data.id}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity: 2, condition: 'SELLABLE' }] })
      .expect(201);

    const inventory = await accountByCode('1200');
    const cogs = await accountByCode('5100');
    const revenue = await accountByCode('4100');
    const ar = await accountByCode('1100');

    const lines = await linesForSource('SaleReturn', ret.body.data.id);
    expect(sumSide(lines, inventory.id, 'debit')).toBe(10);
    expect(sumSide(lines, cogs.id, 'credit')).toBe(10);
    expect(sumSide(lines, revenue.id, 'debit')).toBe(20);
    expect(sumSide(lines, ar.id, 'credit')).toBe(20);
  });

  it('a walk-in sale return corrects Inventory/COGS but posts NO Revenue/AR reversal (documented limitation)', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ACCT-RET-2');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 5 })
      .expect(201);
    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 4, unitPrice: 10 }], payments: [{ amount: 40 }] })
      .expect(201);
    const saleItemId = sale.body.data.items[0].id;

    const ret = await request(app.getHttpServer())
      .post(`/api/v1/sales/${sale.body.data.id}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity: 1, condition: 'SELLABLE' }] })
      .expect(201);

    const revenue = await accountByCode('4100');
    const ar = await accountByCode('1100');
    const inventory = await accountByCode('1200');

    const lines = await linesForSource('SaleReturn', ret.body.data.id);
    expect(lineCountFor(lines, revenue.id)).toBe(0);
    expect(lineCountFor(lines, ar.id)).toBe(0);
    expect(lineCountFor(lines, inventory.id)).toBeGreaterThan(0);
  });

  it('a DAMAGED sale return posts both the Inventory-return-in leg AND the Shrinkage write-off leg', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ACCT-RET-3');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 5 })
      .expect(201);
    const customer = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: 'Damaged Return Customer' }).expect(201);
    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, customerId: customer.body.data.id, items: [{ variantId, quantity: 4, unitPrice: 10 }], payments: [{ amount: 40 }] })
      .expect(201);
    const saleItemId = sale.body.data.items[0].id;

    const ret = await request(app.getHttpServer())
      .post(`/api/v1/sales/${sale.body.data.id}/returns`)
      .set('Authorization', auth())
      .send({ items: [{ saleItemId, quantity: 1, condition: 'DAMAGED' }] })
      .expect(201);

    const inventory = await accountByCode('1200');
    const shrinkage = await accountByCode('5200');
    const lines = await linesForSource('SaleReturn', ret.body.data.id);
    // Two distinct Inventory legs: one debit (return-in), one credit (write-off).
    expect(lineCountFor(lines, inventory.id)).toBe(2);
    expect(sumSide(lines, inventory.id, 'debit')).toBe(5);
    expect(sumSide(lines, inventory.id, 'credit')).toBe(5);
    expect(sumSide(lines, shrinkage.id, 'debit')).toBe(5);
  });

  it('receiving a purchase posts Dr Inventory / Cr Accounts Payable, matching SupplierTransaction exactly', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ACCT-PUR-1');
    const purchase = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, supplierId, items: [{ variantId, quantityOrdered: 10, unitCost: 7 }] })
      .expect(201);
    await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${purchase.body.data.id}/approve`).set('Authorization', auth()).expect(200);
    const receipt = await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchase.body.data.id}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: purchase.body.data.items[0].id, quantityReceived: 10 }] })
      .expect(201);

    const inventory = await accountByCode('1200');
    const ap = await accountByCode('2100');
    const lines = await linesForSource('PurchaseReceipt', receipt.body.data.id);
    expect(sumSide(lines, inventory.id, 'debit')).toBe(70);
    expect(sumSide(lines, ap.id, 'credit')).toBe(70);

    const supplierTxn = await admin.supplierTransaction.findFirstOrThrow({ where: { businessId: biz.businessId, referenceType: 'PurchaseReceipt', referenceId: receipt.body.data.id } });
    expect(Number(supplierTxn.amount)).toBe(70);
  });

  it('COGS <-> StockMovement.unit_cost_at_movement reconciliation: SUM(COGS lines) equals SUM(quantity x unit_cost_at_movement) for every SALE/BUNDLE_CONSUMPTION movement of THIS variant', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ACCT-RECON-COGS');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 50, unitCost: 9 })
      .expect(201);
    const sale1 = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 5, unitPrice: 30 }], payments: [{ amount: 150 }] })
      .expect(201);
    const sale2 = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: 3, unitPrice: 30 }], payments: [{ amount: 90 }] })
      .expect(201);

    const movements = await admin.stockMovement.findMany({ where: { businessId: biz.businessId, variantId, movementType: { in: ['SALE', 'BUNDLE_CONSUMPTION'] } } });
    const expectedCogs = movements.reduce((sum, m) => sum + Math.abs(Number(m.quantityBase)) * Number(m.unitCostAtMovement), 0);

    // Scoped to exactly the two Sale journal entries this test created,
    // not the whole business's COGS account (which other tests in this
    // shared fixture also post to) - the exact "delta, not absolute"
    // discipline the Phase 4/5 reviews already established.
    const cogs = await accountByCode('5100');
    const lines1 = await linesForSource('Sale', sale1.body.data.id);
    const lines2 = await linesForSource('Sale', sale2.body.data.id);
    const totalCogsPosted = sumSide(lines1, cogs.id, 'debit') + sumSide(lines2, cogs.id, 'debit');

    expect(totalCogsPosted).toBeCloseTo(expectedCogs, 4);
  });

  it('Customer subledger <-> AR reconciliation: SUM(CustomerTransaction.amount) equals the AR account balance', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ACCT-RECON-AR');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 3 })
      .expect(201);
    const customer = await request(app.getHttpServer()).post('/api/v1/sales/customers').set('Authorization', auth()).send({ name: 'AR Recon Customer' }).expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, customerId: customer.body.data.id, items: [{ variantId, quantity: 2, unitPrice: 20 }], payments: [{ amount: 15 }] })
      .expect(201);

    // AR is DEBIT-normal - its running balance is the SAME direction as
    // the raw SUM of every CustomerTransaction across every customer
    // (SALE +total increases what's owed, PAYMENT -amount decreases it -
    // exactly what AR's own debit/credit sides mean too).
    const allCustomerTxns = await admin.customerTransaction.findMany({ where: { businessId: biz.businessId } });
    const customerLedgerSum = allCustomerTxns.reduce((sum, t) => sum + Number(t.amount), 0);

    const ar = await accountByCode('1100');
    const balanceRes = await request(app.getHttpServer()).get(`/api/v1/accounting/accounts/${ar.id}/balance`).set('Authorization', auth()).expect(200);
    expect(Number(balanceRes.body.data.balance)).toBeCloseTo(customerLedgerSum, 4);
  });

  it('Supplier subledger <-> AP reconciliation: SUM(SupplierTransaction.amount) equals the AP account balance', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ACCT-RECON-AP');
    const purchase = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, supplierId, items: [{ variantId, quantityOrdered: 6, unitCost: 8 }] })
      .expect(201);
    await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${purchase.body.data.id}/approve`).set('Authorization', auth()).expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchase.body.data.id}/receive`)
      .set('Authorization', auth())
      .send({ items: [{ purchaseItemId: purchase.body.data.items[0].id, quantityReceived: 6 }] })
      .expect(201);

    const allSupplierTxns = await admin.supplierTransaction.findMany({ where: { businessId: biz.businessId } });
    const supplierLedgerSum = allSupplierTxns.reduce((sum, t) => sum + Number(t.amount), 0);

    const ap = await accountByCode('2100');
    const balanceRes = await request(app.getHttpServer()).get(`/api/v1/accounting/accounts/${ap.id}/balance`).set('Authorization', auth()).expect(200);
    // AP is CREDIT-normal - its balance grows with the supplier ledger's own positive (PURCHASE-net) sum.
    expect(Number(balanceRes.body.data.balance)).toBeCloseTo(supplierLedgerSum, 4);
  });

  it('an inventory DAMAGE adjustment posts Dr Inventory Shrinkage / Cr Inventory, and a positive ADJUSTMENT posts Dr Inventory / Cr Inventory Gain', async () => {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'ACCT-ADJ-1');
    await request(app.getHttpServer())
      .post('/api/v1/inventory/opening-stock')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: 4 })
      .expect(201);

    const damageAdj = await request(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: -3, movementType: 'DAMAGE', reason: 'posting test damage' })
      .expect(201);
    const shrinkage = await accountByCode('5200');
    const inventory = await accountByCode('1200');
    const damageLines = await linesForSource('StockMovement', damageAdj.body.data.movementId);
    expect(sumSide(damageLines, shrinkage.id, 'debit')).toBe(12);
    expect(sumSide(damageLines, inventory.id, 'credit')).toBe(12);

    const foundAdj = await request(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', auth())
      .send({ warehouseId: biz.warehouseId, variantId, quantity: 2, movementType: 'ADJUSTMENT', reason: 'posting test found stock' })
      .expect(201);
    const gain = await accountByCode('4200');
    const foundLines = await linesForSource('StockMovement', foundAdj.body.data.movementId);
    expect(sumSide(foundLines, inventory.id, 'debit')).toBe(8);
    expect(sumSide(foundLines, gain.id, 'credit')).toBe(8);
  });

  it('the trial balance stays balanced (SUM debit == SUM credit) after every posting above', async () => {
    const trialBalance = await request(app.getHttpServer()).get('/api/v1/accounting/journal-entries/trial-balance').set('Authorization', auth()).expect(200);
    expect(trialBalance.body.data.balanced).toBe(true);
    expect(Number(trialBalance.body.data.totalDebit)).toBeCloseTo(Number(trialBalance.body.data.totalCredit), 4);
    expect(Number(trialBalance.body.data.totalDebit)).toBeGreaterThan(0);
  });
});
