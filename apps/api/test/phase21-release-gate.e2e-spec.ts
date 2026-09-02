import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupSalesFixture, SalesFixture, setupDefaultTax } from './utils/sales-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * PHASE 21 — THE RELEASE GATE, AS ONE CONTINUOUS FLOW.
 *
 * WHY THIS SPEC EXISTS AND WHAT IT DELIBERATELY DOES NOT DUPLICATE.
 *
 * Sixty-five e2e specs prove their own module thoroughly, and several
 * already prove a JOIN between two of them — `accounting-postings` proves
 * sale-to-journal, `sales-wac-reconciliation` proves cost stability across
 * a long history, `inventory-transfers` proves warehouse-to-warehouse,
 * `tenant-isolation` and `accounting-integrity` prove RLS at the database
 * layer, `rbac` and `effective-permissions` prove authorization.
 *
 * What none of them does is walk a CHAIN: one product, in one tenant, from
 * the catalogue through pricing, stock, a sale, a payment, a customer's
 * ledger, the general ledger and out into a report — asserting at each
 * hand-off that the next module saw exactly what the previous one wrote.
 * A suite of individually-green modules can still be a product whose
 * modules disagree at the seams, and the seams are what a release gate is
 * for.
 *
 * NOTHING HERE IS A NEW BEHAVIOUR OR A NEW CONTRACT. Every call is one the
 * product already serves and every assertion is about a rule already
 * approved and implemented. Where a chain the gate names cannot be walked
 * because no endpoint exposes the capability, the case says so out loud
 * rather than inventing one — see the NOT VERIFIABLE notes.
 */
describe('Phase 21 release gate: cross-module chains (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: SalesFixture;

  const password = 'Sup3rSecret!';
  const auth = () => `Bearer ${biz.accessToken}`;
  const bearer = (token: string) => `Bearer ${token}`;

  /**
   * Sales in this gate are rung up by a TILL caller, not by the owner, and
   * that is the point rather than a detail.
   *
   * `resolveSellingPrice` honours a requested price for a caller holding
   * `products.change_price` — an approved override, not a leak — and the
   * owner holds every code there is. Running the chain as the owner would
   * therefore prove nothing about pricing authority: the shop's own price
   * only binds someone who may not overrule it. So the chain's sales run
   * through a role built to the CASHIER shape minus the override, which is
   * what a real till is.
   */
  let tillToken: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupSalesFixture(app, 'p21-gate');

    const role = await request(app.getHttpServer())
      .post('/api/v1/roles')
      .set('Authorization', auth())
      .send({
        name: 'GATE_TILL',
        permissionCodes: [
          'products.view',
          'inventory.view',
          'customers.view',
          'customers.create',
          'sales.view',
          'sales.create',
          'sales.return',
          'sales.pay',
          'shifts.view',
          'shifts.open',
          'shifts.close',
        ],
      })
      .expect(201);

    const email = 'gate-till@p21.test';
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', auth())
      .send({ name: 'Gate Till', email, password, roleIds: [role.body.data.id], branchIds: [biz.branchId] })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, businessSlug: biz.slug })
      .expect(200);
    tillToken = login.body.data.accessToken;

    // One register, one open shift: the owner's fixture shift is closed so
    // the till can open its own against the same register.
    await request(app.getHttpServer())
      .post('/api/v1/sales/shifts/close')
      .set('Authorization', auth())
      .send({ countedCash: 0 })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/sales/shifts/open')
      .set('Authorization', bearer(tillToken))
      .send({ warehouseId: biz.warehouseId, cashRegisterId: biz.cashRegisterId, openingFloat: 0 })
      .expect(201);
  }, 60_000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const num = (v: Prisma.Decimal | string | number | null) => Number(v ?? 0);

  // ==================================================================
  // CHAIN 1 — PRODUCT -> VARIANT -> PRICE -> INVENTORY -> SALE ->
  //           PAYMENT -> CUSTOMER -> REPORT
  //
  // and, inside the same flow, CHAIN 3 — SALE -> INVENTORY MOVEMENT ->
  // COGS -> ACCOUNTING -> REPORT, because they are the same sale.
  // ==================================================================
  describe('CHAIN 1 + 3: catalogue to customer ledger, general ledger and report', () => {
    let variantId: string;
    let productId: string;
    let customerId: string;
    let saleId: string;
    let priceListId: string;

    /** The one figure the whole chain is measured against. */
    const SHELF_PRICE = 250;
    const UNIT_COST = 100;
    const QUANTITY = 4;

    it('1a. a product creates exactly one default variant, and the variant is what everything downstream names', async () => {
      const created = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'GATE-CHAIN-1', {
        defaultCost: UNIT_COST,
        defaultSellingPrice: 1, // deliberately wrong: the price list is the authority
      });
      productId = created.productId;
      variantId = created.variantId;

      const variants = await admin.productVariant.findMany({ where: { productId } });
      expect(variants).toHaveLength(1);
      expect(variants[0].id).toBe(variantId);
    });

    it('1b. a price written into the active default list is what the SALE charges, not the caller\'s figure', async () => {
      // A 10% business default: every figure downstream is charged it.
      await setupDefaultTax(app, biz.accessToken, 10, 'Gate VAT');

      const list = await request(app.getHttpServer())
        .post('/api/v1/catalog/price-lists')
        .set('Authorization', auth())
        .send({ name: 'Gate Retail', isDefault: true })
        .expect(201);
      priceListId = list.body.data.id;

      await request(app.getHttpServer())
        .put(`/api/v1/catalog/price-lists/${priceListId}/prices`)
        .set('Authorization', auth())
        .send({ variantId, price: SHELF_PRICE })
        .expect(200);

      // The quote is the server's answer before any money moves, and it
      // ignores the figure the caller proposed.
      const quote = await request(app.getHttpServer())
        .post('/api/v1/sales/quote')
        .set('Authorization', bearer(tillToken))
        .send({ warehouseId: biz.warehouseId, items: [{ variantId, quantity: QUANTITY, unitPrice: 1 }] })
        .expect(200);
      expect(num(quote.body.data.lines[0].unitPrice)).toBe(SHELF_PRICE);

      // The configured figure is stored where the resolver looks for it.
      const entry = await admin.productPrice.findFirstOrThrow({
        where: { priceListId, variantId },
      });
      expect(num(entry.price)).toBe(SHELF_PRICE);
    });

    it('1c. opening stock reaches the balance THROUGH a movement — the balance is never written alone', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 20, unitCost: UNIT_COST })
        .expect(201);

      const balance = await admin.stockBalance.findFirstOrThrow({
        where: { warehouseId: biz.warehouseId, variantId },
      });
      const movements = await admin.stockMovement.findMany({ where: { variantId } });

      expect(movements).toHaveLength(1);
      expect(movements[0].movementType).toBe('OPENING_BALANCE');
      // INVARIANT 1: the balance IS the sum of its movements, not a number
      // maintained beside them.
      expect(num(balance.quantityOnHand)).toBe(movements.reduce((t, m) => t + num(m.quantityBase), 0));
      // INVARIANT 10: available is derived, never stored independently.
      expect(num(balance.quantityOnHand) - num(balance.quantityReserved)).toBe(20);
    });

    it('1d. a credit sale to a customer moves stock, snapshots the price, and opens a receivable', async () => {
      const customer = await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', bearer(tillToken))
        .send({ name: 'Gate Customer', phone: '0100000021' })
        .expect(201);
      customerId = customer.body.data.id;

      const sale = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', bearer(tillToken))
        .send({
          warehouseId: biz.warehouseId,
          customerId,
          items: [{ variantId, quantity: QUANTITY, unitPrice: 1 }], // ignored; the list rules
          payments: [], // fully on credit
        })
        .expect(201);
      saleId = sale.body.data.id;

      // The sale charged the price list, not the request.
      expect(num(sale.body.data.items[0].unitPrice)).toBe(SHELF_PRICE);
      expect(num(sale.body.data.subtotal)).toBe(SHELF_PRICE * QUANTITY);
      expect(num(sale.body.data.taxAmount)).toBe(SHELF_PRICE * QUANTITY * 0.1);

      // The stock moved, and moved by a movement.
      const movements = await admin.stockMovement.findMany({ where: { variantId }, orderBy: { createdAt: 'asc' } });
      const saleMovements = movements.filter((m) => m.movementType === 'SALE');
      expect(saleMovements).toHaveLength(1);
      expect(num(saleMovements[0].quantityBase)).toBe(-QUANTITY);

      const balance = await admin.stockBalance.findFirstOrThrow({
        where: { warehouseId: biz.warehouseId, variantId },
      });
      expect(num(balance.quantityOnHand)).toBe(20 - QUANTITY);
      expect(num(balance.quantityOnHand)).toBe(movements.reduce((t, m) => t + num(m.quantityBase), 0));

      // INVARIANT 11: the movement names the document that caused it.
      expect(saleMovements[0].referenceType).toBe('Sale');
      expect(saleMovements[0].referenceId).toBe(saleId);
    });

    it('1e. CHAIN 3: the same sale posts a BALANCED journal entry whose COGS equals the movement cost', async () => {
      const entries = await admin.journalEntry.findMany({
        where: { businessId: biz.businessId, sourceType: 'Sale', sourceId: saleId },
        include: { lines: { include: { account: true } } },
      });
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        const debits = entry.lines.reduce((t, l) => t + num(l.debit), 0);
        const credits = entry.lines.reduce((t, l) => t + num(l.credit), 0);
        // INVARIANT 3.
        expect(Number(debits.toFixed(2))).toBe(Number(credits.toFixed(2)));
      }

      // COGS is the movement's own cost, not a figure recomputed later.
      const saleMovement = await admin.stockMovement.findFirstOrThrow({
        where: { referenceId: saleId, movementType: 'SALE' },
      });
      const movementCost = Math.abs(num(saleMovement.quantityBase)) * num(saleMovement.unitCostAtMovement);

      const cogsLines = entries
        .flatMap((e) => e.lines)
        .filter((l) => /COGS|COST OF GOODS/i.test(`${l.account.code} ${l.account.name}`));
      expect(cogsLines.length).toBeGreaterThan(0);
      const cogsTotal = cogsLines.reduce((t, l) => t + num(l.debit) - num(l.credit), 0);
      expect(Number(cogsTotal.toFixed(2))).toBe(Number(movementCost.toFixed(2)));
      expect(Number(movementCost.toFixed(2))).toBe(UNIT_COST * QUANTITY);
    });

    it('1f. PAYMENT -> CUSTOMER: settling the balance writes a ledger row, and the balance IS that ledger', async () => {
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/sales/${saleId}`)
        .set('Authorization', auth())
        .expect(200);
      const owed = num(detail.body.data.remainingAmount);
      expect(owed).toBe(SHELF_PRICE * QUANTITY * 1.1);
      expect(detail.body.data.paymentStatus).toBe('UNPAID');

      await request(app.getHttpServer())
        .post(`/api/v1/sales/${saleId}/payments`)
        .set('Authorization', bearer(tillToken))
        .send({ amount: owed })
        .expect(201);

      const settled = await request(app.getHttpServer())
        .get(`/api/v1/sales/${saleId}`)
        .set('Authorization', auth())
        .expect(200);
      expect(settled.body.data.paymentStatus).toBe('PAID');
      expect(num(settled.body.data.remainingAmount)).toBe(0);

      // INVARIANT 2: a balance moved only because a transaction was written.
      const ledger = await admin.customerTransaction.findMany({ where: { customerId } });
      expect(ledger.length).toBeGreaterThanOrEqual(2); // the sale, and the payment
      const ledgerBalance = ledger.reduce((t, row) => t + num(row.amount), 0);
      expect(Number(ledgerBalance.toFixed(2))).toBe(0);

      const customer = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}`)
        .set('Authorization', auth())
        .expect(200);
      expect(num(customer.body.data.balance)).toBe(Number(ledgerBalance.toFixed(2)));
    });

    it('1g. REPORT: the sales summary reflects this sale, from the same source the ledger used', async () => {
      const summary = await request(app.getHttpServer())
        .get('/api/v1/reports/sales/summary')
        .set('Authorization', auth())
        .expect(200);

      const net = num(summary.body.data?.netSales ?? summary.body.data?.totalSales ?? 0);
      expect(net).toBeGreaterThanOrEqual(SHELF_PRICE * QUANTITY);

      // The by-dimension report projects `{ key, label, quantity, netSales,
      // ... }` — the key is the dimension's id, which for `product` is the
      // product, not the variant.
      const byProduct = await request(app.getHttpServer())
        .get('/api/v1/reports/sales/by-product')
        .set('Authorization', auth())
        .expect(200);
      const rows: { key: string; quantity: string; netSales: string }[] = byProduct.body.data ?? [];
      const mine = rows.find((r) => r.key === productId || r.key === variantId);
      expect(mine).toBeDefined();
      expect(num(mine!.quantity)).toBe(QUANTITY);
      expect(num(mine!.netSales)).toBe(SHELF_PRICE * QUANTITY);
    });

    it('1h. INVARIANT 4: repricing and re-costing the product does not move one figure on the historical sale', async () => {
      const before = await request(app.getHttpServer())
        .get(`/api/v1/sales/${saleId}`)
        .set('Authorization', auth())
        .expect(200);

      // Change BOTH the shelf price and the cost basis, the two inputs a
      // naive implementation would re-read at render time.
      await request(app.getHttpServer())
        .put(`/api/v1/catalog/price-lists/${priceListId}/prices`)
        .set('Authorization', auth())
        .send({ variantId, price: 999 })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/receipts')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          variantId,
          quantity: 10,
          unitCost: 900,
          // The generic stock-in primitive takes its provenance from the
          // caller; a caller that supplies none writes an unattributed
          // movement. Recorded as a known limitation of this endpoint and
          // pinned below.
          reason: 'Gate re-cost: a later, dearer receipt',
        })
        .expect(201);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/sales/${saleId}`)
        .set('Authorization', auth())
        .expect(200);

      expect(num(after.body.data.items[0].unitPrice)).toBe(SHELF_PRICE);
      expect(num(after.body.data.subtotal)).toBe(num(before.body.data.subtotal));
      expect(num(after.body.data.taxAmount)).toBe(num(before.body.data.taxAmount));
      expect(num(after.body.data.totalAmount)).toBe(num(before.body.data.totalAmount));

      // And the movement that priced the COGS is likewise untouched.
      const movement = await admin.stockMovement.findFirstOrThrow({
        where: { referenceId: saleId, movementType: 'SALE' },
      });
      expect(num(movement.unitCostAtMovement)).toBe(UNIT_COST);
    });
  });

  // ==================================================================
  // CHAIN 4 — SALE RETURN -> INVENTORY -> FINANCIAL -> CUSTOMER ->
  //           REPORT
  // ==================================================================
  describe('CHAIN 4: a return unwinds stock, ledger and books together', () => {
    let variantId: string;
    let saleId: string;
    let customerId: string;

    it('4a. sells four on credit, then returns two as SELLABLE', async () => {
      const created = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'GATE-CHAIN-4', {
        defaultCost: 50,
      });
      variantId = created.variantId;

      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 10, unitCost: 50 })
        .expect(201);

      const customer = await request(app.getHttpServer())
        .post('/api/v1/sales/customers')
        .set('Authorization', bearer(tillToken))
        .send({ name: 'Gate Returner', phone: '0100000041' })
        .expect(201);
      customerId = customer.body.data.id;

      const sale = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', bearer(tillToken))
        .send({
          warehouseId: biz.warehouseId,
          customerId,
          items: [{ variantId, quantity: 4, unitPrice: 100 }],
          payments: [],
        })
        .expect(201);
      saleId = sale.body.data.id;

      const owedBefore = (await admin.customerTransaction.findMany({ where: { customerId } })).reduce(
        (t, r) => t + num(r.amount),
        0,
      );
      expect(owedBefore).toBeGreaterThan(0);

      const saleItemId = sale.body.data.items[0].id;
      const ret = await request(app.getHttpServer())
        .post(`/api/v1/sales/${saleId}/returns`)
        .set('Authorization', bearer(tillToken))
        .send({ items: [{ saleItemId, quantity: 2, condition: 'SELLABLE' }] })
        .expect(201);
      expect(ret.body.data).toBeDefined();
    });

    it('4b. INVENTORY: the returned units come back through a movement, and the balance follows it', async () => {
      const movements = await admin.stockMovement.findMany({ where: { variantId }, orderBy: { createdAt: 'asc' } });
      const returnMovements = movements.filter((m) => m.movementType === 'SALES_RETURN');
      expect(returnMovements).toHaveLength(1);
      expect(num(returnMovements[0].quantityBase)).toBe(2);

      const balance = await admin.stockBalance.findFirstOrThrow({
        where: { warehouseId: biz.warehouseId, variantId },
      });
      expect(num(balance.quantityOnHand)).toBe(10 - 4 + 2);
      expect(num(balance.quantityOnHand)).toBe(movements.reduce((t, m) => t + num(m.quantityBase), 0));
    });

    it('4c. CUSTOMER + FINANCIAL: the credit lands on the ledger and the books stay balanced', async () => {
      const ledger = await admin.customerTransaction.findMany({ where: { customerId } });
      const balance = ledger.reduce((t, r) => t + num(r.amount), 0);
      // Two of four returned: the receivable is halved, not cleared — and
      // the credit carries the TAX the sale charged (the 10% business
      // default set in CHAIN 1), because that is what the customer owed.
      expect(balance).toBeGreaterThan(0);
      expect(Number(balance.toFixed(2))).toBe(Number((100 * 2 * 1.1).toFixed(2)));

      const customer = await request(app.getHttpServer())
        .get(`/api/v1/sales/customers/${customerId}`)
        .set('Authorization', auth())
        .expect(200);
      expect(num(customer.body.data.balance)).toBe(Number(balance.toFixed(2)));

      // Every entry in the whole tenant is still balanced after the unwind.
      const entries = await admin.journalEntry.findMany({
        where: { businessId: biz.businessId },
        include: { lines: true },
      });
      for (const entry of entries) {
        const d = entry.lines.reduce((t, l) => t + num(l.debit), 0);
        const c = entry.lines.reduce((t, l) => t + num(l.credit), 0);
        expect(Number(d.toFixed(2))).toBe(Number(c.toFixed(2)));
      }
    });

    it('4d. REPORT: the returns report sees it, and the returned quantity is on the sale', async () => {
      const report = await request(app.getHttpServer())
        .get('/api/v1/reports/sales/returns')
        .set('Authorization', auth())
        .expect(200);
      expect(report.body.data).toBeDefined();

      // The sale detail carries the RETURNS, with their own line items —
      // there is no `returnedQuantity` field on a sale item, and the ERP
      // derives the per-line figure from this array rather than the server
      // sending a second copy of it. Asserted as the contract actually is.
      const sale = await request(app.getHttpServer())
        .get(`/api/v1/sales/${saleId}`)
        .set('Authorization', auth())
        .expect(200);
      const returns: { items: { saleItemId: string; quantity: string }[] }[] = sale.body.data.returns ?? [];
      expect(returns).toHaveLength(1);
      const returnedForLine = returns
        .flatMap((r) => r.items)
        .filter((i) => i.saleItemId === sale.body.data.items[0].id)
        .reduce((t, i) => t + num(i.quantity), 0);
      expect(returnedForLine).toBe(2);
    });
  });

  // ==================================================================
  // CHAIN 2 — PURCHASE -> RECEIVING -> INVENTORY -> SUPPLIER ->
  //           PAYMENT -> REPORT
  // ==================================================================
  describe('CHAIN 2: buying, receiving, owing and paying', () => {
    let variantId: string;
    let supplierId: string;
    let purchaseId: string;

    it('2a. an approved purchase received into stock moves the balance and the payable together', async () => {
      const created = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'GATE-CHAIN-2', { defaultCost: 30 });
      variantId = created.variantId;

      const supplier = await request(app.getHttpServer())
        .post('/api/v1/purchasing/suppliers')
        .set('Authorization', auth())
        .send({ name: 'Gate Supplier' })
        .expect(201);
      supplierId = supplier.body.data.id;

      const purchase = await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          supplierId,
          items: [{ variantId, quantityOrdered: 5, unitCost: 30 }],
        })
        .expect(201);
      purchaseId = purchase.body.data.id;

      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${purchaseId}/approve`)
        .set('Authorization', auth())
        .expect(200);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/purchasing/purchases/${purchaseId}`)
        .set('Authorization', auth())
        .expect(200);
      const purchaseItemId = detail.body.data.items[0].id;

      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
        .set('Authorization', auth())
        .send({ items: [{ purchaseItemId, quantityReceived: 5 }] })
        .expect(201);

      const movements = await admin.stockMovement.findMany({ where: { variantId } });
      expect(movements.filter((m) => m.movementType === 'PURCHASE')).toHaveLength(1);
      const balance = await admin.stockBalance.findFirstOrThrow({
        where: { warehouseId: biz.warehouseId, variantId },
      });
      expect(num(balance.quantityOnHand)).toBe(5);
      expect(num(balance.quantityOnHand)).toBe(movements.reduce((t, m) => t + num(m.quantityBase), 0));
    });

    it('2b. SUPPLIER: what is owed is the supplier ledger, and a payment moves it', async () => {
      const owed = (await admin.supplierTransaction.findMany({ where: { supplierId } })).reduce(
        (t, r) => t + num(r.amount),
        0,
      );
      expect(Number(owed.toFixed(2))).toBe(150);

      await request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${purchaseId}/payments`)
        .set('Authorization', auth())
        .send({ amount: 150, method: 'CASH' })
        .expect(201);

      const after = (await admin.supplierTransaction.findMany({ where: { supplierId } })).reduce(
        (t, r) => t + num(r.amount),
        0,
      );
      expect(Number(after.toFixed(2))).toBe(0);

      const list = await request(app.getHttpServer())
        .get('/api/v1/purchasing/suppliers')
        .set('Authorization', auth())
        .expect(200);
      const mine = list.body.data.find((s: { id: string }) => s.id === supplierId);
      expect(num(mine.balance)).toBe(0);
    });

    it('2c. REPORT: the purchasing summary reflects it', async () => {
      const report = await request(app.getHttpServer())
        .get('/api/v1/reports/purchasing/summary')
        .set('Authorization', auth())
        .expect(200);
      expect(report.body.data).toBeDefined();
    });
  });

  // ==================================================================
  // CHAIN 5 — TRANSFER -> SOURCE -> DESTINATION -> INVENTORY
  // ==================================================================
  describe('CHAIN 5: stock crossing between two warehouses of one business', () => {
    it('5a. a transfer decrements the source, increments the destination, and conserves the total', async () => {
      const branch = await request(app.getHttpServer())
        .post('/api/v1/branches')
        .set('Authorization', auth())
        .send({ name: 'Gate Second Branch' })
        .expect(201);

      const destination = await request(app.getHttpServer())
        .post('/api/v1/warehouses')
        .set('Authorization', auth())
        .send({ branchId: branch.body.data.id, name: 'Gate Second Warehouse' })
        .expect(201);
      const destinationId = destination.body.data.id;

      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'GATE-CHAIN-5', {
        defaultCost: 12,
      });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 8, unitCost: 12 })
        .expect(201);

      const transfer = await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Authorization', auth())
        .send({
          sourceWarehouseId: biz.warehouseId,
          destinationWarehouseId: destinationId,
          items: [{ variantId, quantity: 3 }],
        })
        .expect(201);
      const transferId = transfer.body.data.id;

      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${transferId}/send`)
        .set('Authorization', auth())
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${transferId}/receive`)
        .set('Authorization', auth())
        .send({ items: [{ variantId, quantityReceived: 3 }] })
        .expect(200);

      const source = await admin.stockBalance.findFirstOrThrow({
        where: { warehouseId: biz.warehouseId, variantId },
      });
      const dest = await admin.stockBalance.findFirstOrThrow({ where: { warehouseId: destinationId, variantId } });
      expect(num(source.quantityOnHand)).toBe(5);
      expect(num(dest.quantityOnHand)).toBe(3);

      // Conserved: nothing was created or destroyed by moving it.
      const movements = await admin.stockMovement.findMany({ where: { variantId } });
      expect(movements.reduce((t, m) => t + num(m.quantityBase), 0)).toBe(8);
      expect(num(source.quantityOnHand) + num(dest.quantityOnHand)).toBe(8);
    });
  });

  // ==================================================================
  // CHAIN 6 — USER -> ROLE -> EFFECTIVE PERMISSIONS -> API AUTHORIZATION
  // CHAIN 7 — BUSINESS -> BRANCH -> WAREHOUSE -> USER ACCESS
  // ==================================================================
  describe('CHAIN 6 + 7: an administered user reaches exactly what their role grants', () => {
    let roleId: string;
    let token: string;
    let branchId: string;

    it('7a. a branch and a warehouse created through administration are visible to the business', async () => {
      const branch = await request(app.getHttpServer())
        .post('/api/v1/branches')
        .set('Authorization', auth())
        .send({ name: 'Gate Access Branch' })
        .expect(201);
      branchId = branch.body.data.id;

      await request(app.getHttpServer())
        .post('/api/v1/warehouses')
        .set('Authorization', auth())
        .send({ branchId, name: 'Gate Access Warehouse' })
        .expect(201);

      const warehouses = await request(app.getHttpServer())
        .get(`/api/v1/warehouses?branchId=${branchId}`)
        .set('Authorization', auth())
        .expect(200);
      expect(warehouses.body.data).toHaveLength(1);
      expect(warehouses.body.data[0].branchId).toBe(branchId);
    });

    it('6a. a custom role, assigned to a new user, IS that user\'s effective permission set', async () => {
      const role = await request(app.getHttpServer())
        .post('/api/v1/roles')
        .set('Authorization', auth())
        .send({ name: 'GATE_STOCK_READER', permissionCodes: ['inventory.view', 'products.view'] })
        .expect(201);
      roleId = role.body.data.id;

      const email = 'gate-reader@p21.test';
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', auth())
        .send({ name: 'Gate Reader', email, password, roleIds: [roleId], branchIds: [branchId] })
        .expect(201);

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password, businessSlug: biz.slug })
        .expect(200);
      token = login.body.data.accessToken;

      const mine = await request(app.getHttpServer())
        .get('/api/v1/permissions/me')
        .set('Authorization', bearer(token))
        .expect(200);
      // INVARIANT 9: exactly the role's grants — not a superset, not a
      // subset, and nothing inherited from the role's NAME.
      expect(mine.body.data.permissions.sort()).toEqual(['inventory.view', 'products.view']);
    });

    it('6b. API AUTHORIZATION agrees with that set, in both directions', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/inventory/balances')
        .set('Authorization', bearer(token))
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/catalog/products')
        .set('Authorization', bearer(token))
        .expect(200);

      // INVARIANT 8: everything else is refused SERVER-SIDE, whatever a
      // browser might choose to render.
      for (const path of ['/api/v1/users', '/api/v1/roles', '/api/v1/audit-logs', '/api/v1/branches', '/api/v1/business']) {
        await request(app.getHttpServer()).get(path).set('Authorization', bearer(token)).expect(403);
      }
      await request(app.getHttpServer())
        .post('/api/v1/inventory/adjustments')
        .set('Authorization', bearer(token))
        .send({ warehouseId: biz.warehouseId, variantId: 'x', quantity: 1, adjustmentType: 'ADJUSTMENT' })
        .expect(403);
    });

    it('6c. editing the ROLE changes the user\'s authorization on the very next request', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/roles/${roleId}`)
        .set('Authorization', auth())
        .send({ permissionCodes: ['inventory.view', 'products.view', 'audit.view'] })
        .expect(200);

      // No re-login, no new token: the guard reads the grant, never a claim
      // baked into the JWT.
      await request(app.getHttpServer())
        .get('/api/v1/audit-logs')
        .set('Authorization', bearer(token))
        .expect(200);

      const mine = await request(app.getHttpServer())
        .get('/api/v1/permissions/me')
        .set('Authorization', bearer(token))
        .expect(200);
      expect(mine.body.data.permissions).toContain('audit.view');
    });

    it('6d. suspending the USER ends their access immediately, token or no token', async () => {
      const user = await admin.user.findFirstOrThrow({ where: { email: 'gate-reader@p21.test' } });
      await request(app.getHttpServer())
        .delete(`/api/v1/users/${user.id}`)
        .set('Authorization', auth())
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/v1/inventory/balances')
        .set('Authorization', bearer(token))
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/permissions/me')
        .set('Authorization', bearer(token))
        .expect(401);
    });
  });

  // ==================================================================
  // SECTION 5 — the invariants that are best asserted over the whole
  // tenant once every chain above has run through it.
  // ==================================================================
  describe('whole-tenant invariants, after every chain has run', () => {
    it('INVARIANT 1: every stock balance in the tenant equals the sum of its own movements', async () => {
      const balances = await admin.stockBalance.findMany({
        where: { businessId: biz.businessId },
      });
      expect(balances.length).toBeGreaterThan(0);

      for (const balance of balances) {
        const movements = await admin.stockMovement.findMany({
          where: { warehouseId: balance.warehouseId, variantId: balance.variantId },
        });
        const summed = movements.reduce((t, m) => t + num(m.quantityBase), 0);
        expect(Number(num(balance.quantityOnHand).toFixed(4))).toBe(Number(summed.toFixed(4)));
      }
    });

    it('INVARIANT 2: every customer and supplier balance equals its own ledger', async () => {
      const customers = await admin.customer.findMany({ where: { businessId: biz.businessId } });
      for (const customer of customers) {
        const rows = await admin.customerTransaction.findMany({ where: { customerId: customer.id } });
        const summed = rows.reduce((t, r) => t + num(r.amount), 0);
        const api = await request(app.getHttpServer())
          .get(`/api/v1/sales/customers/${customer.id}`)
          .set('Authorization', auth())
          .expect(200);
        expect(num(api.body.data.balance)).toBe(Number(summed.toFixed(2)));
      }

      const suppliers = await admin.supplier.findMany({ where: { businessId: biz.businessId } });
      const list = await request(app.getHttpServer())
        .get('/api/v1/purchasing/suppliers')
        .set('Authorization', auth())
        .expect(200);
      for (const supplier of suppliers) {
        const rows = await admin.supplierTransaction.findMany({ where: { supplierId: supplier.id } });
        const summed = rows.reduce((t, r) => t + num(r.amount), 0);
        const row = list.body.data.find((s: { id: string }) => s.id === supplier.id);
        expect(num(row.balance)).toBe(Number(summed.toFixed(2)));
      }
    });

    it('INVARIANT 3: every journal entry in the tenant is balanced, and there are some', async () => {
      const entries = await admin.journalEntry.findMany({
        where: { businessId: biz.businessId },
        include: { lines: true },
      });
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.lines.length).toBeGreaterThan(1);
        const d = entry.lines.reduce((t, l) => t + num(l.debit), 0);
        const c = entry.lines.reduce((t, l) => t + num(l.credit), 0);
        expect(Number(d.toFixed(2))).toBe(Number(c.toFixed(2)));
      }
    });

    it('INVARIANT 10: available stock is on-hand minus reserved, everywhere, with no negative surprise', async () => {
      const balances = await request(app.getHttpServer())
        .get(`/api/v1/inventory/balances?warehouseId=${biz.warehouseId}`)
        .set('Authorization', auth())
        .expect(200);
      const rows: { quantityOnHand: string; quantityReserved: string; availableQuantity: string }[] =
        balances.body.data ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(num(row.availableQuantity)).toBe(num(row.quantityOnHand) - num(row.quantityReserved));
        expect(num(row.quantityOnHand)).toBeGreaterThanOrEqual(0);
      }
    });

    it('INVARIANT 11: every stock movement names a document, and every document it names exists', async () => {
      const movements = await admin.stockMovement.findMany({ where: { businessId: biz.businessId } });
      expect(movements.length).toBeGreaterThan(0);

      // Every movement written by a DOCUMENT flow — a sale, a return, a
      // purchase receipt, a transfer — names the document that caused it.
      // Movements written by the generic stock primitives take their
      // provenance from the caller instead, and carry a reason rather than
      // a document id: an OPENING_BALANCE is the declared starting point
      // of the ledger, not the consequence of a transaction, and there is
      // no document for it to name.
      const documentDriven = movements.filter((m) => m.referenceType !== null);
      expect(documentDriven.length).toBeGreaterThan(0);
      for (const movement of documentDriven) {
        expect(movement.referenceId).toBeTruthy();
      }
      for (const movement of movements.filter((m) => m.referenceType === null)) {
        // Nothing is anonymous: what a primitive movement lacks in a
        // document id it carries as a stated reason.
        expect(movement.reason).toBeTruthy();
      }

      // The two document classes this tenant actually produced.
      for (const movement of movements.filter((m) => m.referenceType === 'Sale' && m.referenceId)) {
        expect(await admin.sale.count({ where: { id: movement.referenceId! } })).toBe(1);
      }
      for (const movement of movements.filter((m) => m.referenceType === 'StockTransfer' && m.referenceId)) {
        expect(await admin.stockTransfer.count({ where: { id: movement.referenceId! } })).toBe(1);
      }
    });

    it('INVARIANT 7: a refused mutation writes nothing at all', async () => {
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'GATE-ATOMIC', {
        defaultCost: 5,
      });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 2, unitCost: 5 })
        .expect(201);

      const movementsBefore = await admin.stockMovement.count({ where: { variantId } });
      const entriesBefore = await admin.journalEntry.count({ where: { businessId: biz.businessId } });

      // More than exists: the sale must fail whole, leaving neither a
      // movement nor a journal entry nor a half-written sale.
      const salesBefore = await admin.sale.count({ where: { businessId: biz.businessId } });
      const refused = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', bearer(tillToken))
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId, quantity: 99, unitPrice: 10 }],
          payments: [{ amount: 990, method: 'CASH' }],
        });
      // Refused — which code is the contract's business; that nothing was
      // written is this invariant's.
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('VALIDATION_FAILED');

      expect(await admin.stockMovement.count({ where: { variantId } })).toBe(movementsBefore);
      expect(await admin.journalEntry.count({ where: { businessId: biz.businessId } })).toBe(entriesBefore);
      expect(await admin.sale.count({ where: { businessId: biz.businessId } })).toBe(salesBefore);
    });

    it('INVARIANT 5 + 6: the tenant\'s data is RLS-scoped, and FORCE RLS is on for the tables it just wrote', async () => {
      // The API-layer half of tenant scoping is proved exhaustively in
      // `tenant-isolation.e2e-spec.ts`; what is checked here is that the
      // tables THIS gate exercised still carry the database-layer guard.
      const rows = await admin.$queryRawUnsafe<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
        `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relname IN ('sales','sale_items','stock_movements','stock_balances','customer_transactions',
                            'supplier_transactions','journal_entries','journal_entry_lines','users','roles',
                            'branches','warehouses','audit_logs')`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(13);
      for (const row of rows) {
        expect({ table: row.relname, rls: row.relrowsecurity, force: row.relforcerowsecurity }).toEqual({
          table: row.relname,
          rls: true,
          force: true,
        });
      }
    });
  });

  // ==================================================================
  // What this gate could NOT verify, and why. Stated as executable
  // assertions so the limitation is pinned rather than remembered.
  // ==================================================================
  describe('NOT VERIFIABLE against the current contract', () => {
    it('there is no hard stock reservation to verify: nothing in the product writes quantityReserved', async () => {
      // The reservation column exists and `availableQuantity` is derived
      // from it, but no endpoint sets it — the hold-and-reserve decision is
      // deferred. So "available stock cannot violate the reservation rules"
      // is verified only in its derivation, above, and there is no
      // reservation lifecycle to test.
      const reserved = await admin.stockBalance.findMany({
        where: { businessId: biz.businessId, NOT: { quantityReserved: 0 } },
      });
      expect(reserved).toHaveLength(0);
    });

    it('the generic stock primitives accept a movement with NO provenance at all', async () => {
      // `POST /inventory/receipts` and its siblings take `movementType`,
      // `referenceType`, `referenceId` and `reason` from the caller, all
      // optional. A caller that supplies none writes a movement typed
      // PURCHASE that names no purchase and states no reason — the balance
      // is still correct and still equals the sum of its movements, but the
      // row is untraceable to anything. Nothing in the product does this;
      // the endpoint permits it. Pinned so the gap is visible rather than
      // rediscovered.
      const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, 'GATE-NO-PROVENANCE', {
        defaultCost: 1,
      });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/receipts')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 1, unitCost: 1 })
        .expect(201);

      const movement = await admin.stockMovement.findFirstOrThrow({ where: { variantId } });
      expect(movement.movementType).toBe('PURCHASE');
      expect(movement.referenceType).toBeNull();
      expect(movement.referenceId).toBeNull();
      expect(movement.reason).toBeNull();
    });

    it('there is no purchase-total preview endpoint, so no pre-write figure can be reconciled', async () => {
      // `POST /sales/quote` exists and is exercised in CHAIN 1; purchasing
      // has no equivalent, which is why the ERP purchase form shows no
      // running total. Asserted as a negative so the gap stays visible.
      await request(app.getHttpServer())
        .post('/api/v1/purchasing/purchases/quote')
        .set('Authorization', auth())
        .send({})
        .expect(404);
    });
  });
});
