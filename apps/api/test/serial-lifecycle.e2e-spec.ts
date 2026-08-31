import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/app-factory';
import { resetDatabase } from './db-reset';
import { setupPurchasingFixture, PurchasingFixture, createApprovedPurchase } from './utils/purchasing-fixtures';
import { createSimpleProduct } from './utils/inventory-fixtures';

/**
 * Phase 10 (10D) — the serial lifecycle everywhere OTHER than the sale.
 *
 * Phase 8E made serials mandatory on the way out (BD-13) and gave a
 * returned unit a disposition (BD-14). It left three holes on every other
 * path a physical unit can take, and this spec exists to keep them shut:
 *
 *   1. GOODS RECEIPT registered no serials at all, so a serial-tracked
 *      product bought on a purchase order arrived as unsellable stock —
 *      BD-13 demanded a serial per unit at the till and there were none.
 *   2. A STOCK TRANSFER moved quantities and ignored serials, leaving the
 *      unit's row pointing at the warehouse it had physically left. It
 *      could then be sold at NEITHER end. This was the worst of the three
 *      because it failed silently: the transfer succeeded and only a later
 *      sale broke, in a different warehouse, on a different day.
 *   3. A PURCHASE RETURN sent goods back to the supplier and left the
 *      serials sitting in stock as though the units were still there.
 *
 * The lifecycle now closed:
 *
 *   (receipt) -> IN_STOCK -> SOLD                       (Phase 8E)
 *                  |  ^
 *          send ---+  +--- receive
 *                  v
 *             IN_TRANSIT
 *
 *   IN_STOCK -> RETURNED_TO_SUPPLIER                    (terminal)
 */
describe('Serial lifecycle across purchasing and transfers (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let biz: PurchasingFixture;
  let secondWarehouseId: string;

  let seq = 0;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    biz = await setupPurchasingFixture(app, 'serials10d');

    const wh = await request(app.getHttpServer())
      .post('/api/v1/warehouses')
      .set('Authorization', auth())
      .send({ branchId: biz.branchId, name: 'Serial Destination' })
      .expect(201);
    secondWarehouseId = wh.body.data.id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const auth = () => `Bearer ${biz.accessToken}`;

  async function trackedVariant() {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `SN-${seq++}`, {
      tracksSerialNumbers: true,
      defaultCost: 10,
    });
    return variantId;
  }

  async function plainVariant() {
    const { variantId } = await createSimpleProduct(app, biz.accessToken, biz.uomId, `PL-${seq++}`, { defaultCost: 10 });
    return variantId;
  }

  async function purchaseItemId(purchaseId: string, variantId: string) {
    const purchase = await request(app.getHttpServer())
      .get(`/api/v1/purchasing/purchases/${purchaseId}`)
      .set('Authorization', auth())
      .expect(200);
    return purchase.body.data.items.find((i: { variantId: string }) => i.variantId === variantId).id as string;
  }

  function receive(purchaseId: string, items: Record<string, unknown>[]) {
    return request(app.getHttpServer())
      .post(`/api/v1/purchasing/purchases/${purchaseId}/receive`)
      .set('Authorization', auth())
      .send({ items });
  }

  const serialRow = (serial: string) =>
    admin.serialNumber.findFirstOrThrow({ where: { businessId: biz.businessId, serial } });

  /**
   * Opens a shift against `warehouseId`, closing whatever shift is already
   * open first. Phase 10 (BD-17 rule 10) allows one open shift per
   * register, so a spec that sells from two warehouses has to hand the
   * register over rather than hold both at once.
   */
  async function openShiftAt(warehouseId: string) {
    const open = await admin.shift.findFirst({ where: { businessId: biz.businessId, status: 'OPEN' } });
    if (open) {
      if (open.warehouseId === warehouseId) return;
      const cash = await admin.cashTransaction.aggregate({
        where: { businessId: biz.businessId, shiftId: open.id },
        _sum: { amount: true },
      });
      await request(app.getHttpServer())
        .post('/api/v1/sales/shifts/close')
        .set('Authorization', auth())
        .send({ countedCash: Number(cash._sum.amount ?? 0) + Number(open.openingFloat) })
        .expect(200);
    }
    const registers = await request(app.getHttpServer()).get('/api/v1/cash-registers').set('Authorization', auth()).expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/sales/shifts/open')
      .set('Authorization', auth())
      .send({ warehouseId, cashRegisterId: registers.body.data[0].id, openingFloat: 0 })
      .expect(201);
  }

  /** Receives `serials` of a fresh tracked variant through a real PO. */
  async function receivedTrackedVariant(serials: string[], warehouseId = biz.warehouseId) {
    const variantId = await trackedVariant();
    const created = await request(app.getHttpServer())
      .post('/api/v1/purchasing/purchases')
      .set('Authorization', auth())
      .send({
        warehouseId,
        supplierId: biz.supplierId,
        items: [{ variantId, quantityOrdered: serials.length, unitCost: 10 }],
      })
      .expect(201);
    const purchaseId = created.body.data.id as string;
    await request(app.getHttpServer()).post(`/api/v1/purchasing/purchases/${purchaseId}/approve`).set('Authorization', auth()).expect(200);
    const itemId = await purchaseItemId(purchaseId, variantId);
    await receive(purchaseId, [{ purchaseItemId: itemId, quantityReceived: serials.length, serials }]).expect(201);
    return { variantId, purchaseId, purchaseItemId: itemId };
  }

  // ==================================================================
  describe('Goods receipt registers the physical units', () => {
    it('registers each serial IN_STOCK at the purchase warehouse and records which receipt line brought it in', async () => {
      const { variantId } = await receivedTrackedVariant(['GRN-A1', 'GRN-A2', 'GRN-A3']);

      for (const serial of ['GRN-A1', 'GRN-A2', 'GRN-A3']) {
        const row = await serialRow(serial);
        expect(row.status).toBe('IN_STOCK');
        expect(row.currentWarehouseId).toBe(biz.warehouseId);
        expect(row.variantId).toBe(variantId);
      }

      // Provenance: the mirror of `sale_item_serials` on the buy side.
      const links = await admin.purchaseReceiptItemSerial.findMany({
        where: { businessId: biz.businessId },
        include: { serialNumber: true },
      });
      expect(links.map((l) => l.serialNumber.serial).sort()).toEqual(['GRN-A1', 'GRN-A2', 'GRN-A3']);
    });

    it('REGRESSION (pre-existing defect): receiving a serial-tracked line with NO serials is refused', async () => {
      // This used to SUCCEED. Stock went up, no unit was registered, and
      // the goods were then unsellable because BD-13 requires a serial per
      // unit at the till and there were none to give. The failure surfaced
      // only at the point of sale, long after the receipt.
      const variantId = await trackedVariant();
      const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [
        { variantId, quantityOrdered: 2, unitCost: 10 },
      ]);
      const itemId = await purchaseItemId(purchaseId, variantId);

      await receive(purchaseId, [{ purchaseItemId: itemId, quantityReceived: 2 }]).expect(422);

      // The whole transaction rolled back: no stock, no receipt.
      const balance = await admin.stockBalance.findFirst({ where: { businessId: biz.businessId, variantId } });
      expect(balance).toBeNull();
      expect(await admin.purchaseReceipt.count({ where: { purchaseId } })).toBe(0);
    });

    it('refuses a serial count that disagrees with the quantity, and duplicate serials in one request', async () => {
      const variantId = await trackedVariant();
      const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [
        { variantId, quantityOrdered: 3, unitCost: 10 },
      ]);
      const itemId = await purchaseItemId(purchaseId, variantId);

      await receive(purchaseId, [{ purchaseItemId: itemId, quantityReceived: 3, serials: ['X1', 'X2'] }]).expect(422);
      await receive(purchaseId, [{ purchaseItemId: itemId, quantityReceived: 3, serials: ['X1', 'X1', 'X2'] }]).expect(422);
      await receive(purchaseId, [{ purchaseItemId: itemId, quantityReceived: 3, serials: ['X1', 'X2', 'X3'] }]).expect(201);
    });

    it('refuses serials on a variant that is not serial-tracked - the SERVER decides, not the request', async () => {
      const variantId = await plainVariant();
      const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [
        { variantId, quantityOrdered: 2, unitCost: 10 },
      ]);
      const itemId = await purchaseItemId(purchaseId, variantId);
      await receive(purchaseId, [{ purchaseItemId: itemId, quantityReceived: 2, serials: ['NOPE-1', 'NOPE-2'] }]).expect(422);
    });

    it('refuses a serial that is already registered anywhere in the tenant', async () => {
      await receivedTrackedVariant(['UNIQ-1']);
      const variantId = await trackedVariant();
      const purchaseId = await createApprovedPurchase(app, biz.accessToken, biz, [
        { variantId, quantityOrdered: 1, unitCost: 10 },
      ]);
      const itemId = await purchaseItemId(purchaseId, variantId);
      await receive(purchaseId, [{ purchaseItemId: itemId, quantityReceived: 1, serials: ['UNIQ-1'] }]).expect(409);
    });

    it('goods received on a PO are immediately sellable - which is the whole point of the fix', async () => {
      const { variantId } = await receivedTrackedVariant(['SELLABLE-1']);

      await openShiftAt(biz.warehouseId);

      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId, quantity: 1, unitPrice: 50, serials: ['SELLABLE-1'] }],
          payments: [{ amount: 50 }],
        })
        .expect(201);

      expect((await serialRow('SELLABLE-1')).status).toBe('SOLD');
    });
  });

  // ==================================================================
  describe('A stock transfer moves the physical units with the goods', () => {
    async function transferOf(variantId: string, quantity: number) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Authorization', auth())
        .send({
          sourceWarehouseId: biz.warehouseId,
          destinationWarehouseId: secondWarehouseId,
          items: [{ variantId, quantity }],
        })
        .expect(201);
      return res.body.data.id as string;
    }

    const send = (transferId: string, body: Record<string, unknown>) =>
      request(app.getHttpServer()).post(`/api/v1/inventory/transfers/${transferId}/send`).set('Authorization', auth()).send(body);

    const receiveTransfer = (transferId: string, body: Record<string, unknown>) =>
      request(app.getHttpServer()).post(`/api/v1/inventory/transfers/${transferId}/receive`).set('Authorization', auth()).send(body);

    it('IN_STOCK at source -> IN_TRANSIT (owned by neither warehouse) -> IN_STOCK at destination', async () => {
      const { variantId } = await receivedTrackedVariant(['TR-1', 'TR-2']);
      const transferId = await transferOf(variantId, 2);

      await send(transferId, { items: [{ variantId, serials: ['TR-1', 'TR-2'] }] }).expect(200);

      // In the van: belonging to neither end. Leaving them pointed at the
      // source is what would let the same unit be sold out from under a
      // transfer that has already shipped it.
      for (const serial of ['TR-1', 'TR-2']) {
        const row = await serialRow(serial);
        expect(row.status).toBe('IN_TRANSIT');
        expect(row.currentWarehouseId).toBeNull();
      }

      await receiveTransfer(transferId, { items: [{ variantId, quantityReceived: 2, serials: ['TR-1', 'TR-2'] }] }).expect(200);

      for (const serial of ['TR-1', 'TR-2']) {
        const row = await serialRow(serial);
        expect(row.status).toBe('IN_STOCK');
        expect(row.currentWarehouseId).toBe(secondWarehouseId);
      }
    });

    it('REGRESSION: a transferred unit is sellable at the DESTINATION and no longer at the source', async () => {
      // The silent failure this closes: before Phase 10 the serial kept
      // pointing at the source warehouse, so the sale below failed at the
      // destination while the stock it needed was sitting right there.
      const { variantId } = await receivedTrackedVariant(['MOVED-1']);
      const transferId = await transferOf(variantId, 1);
      await send(transferId, { items: [{ variantId, serials: ['MOVED-1'] }] }).expect(200);
      await receiveTransfer(transferId, { items: [{ variantId, quantityReceived: 1, serials: ['MOVED-1'] }] }).expect(200);

      await openShiftAt(biz.warehouseId);

      // Selling it from the SOURCE is refused - the goods are not there.
      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId, quantity: 1, unitPrice: 50, serials: ['MOVED-1'] }],
          payments: [{ amount: 50 }],
        })
        .expect(409);

      // Selling it from the DESTINATION works. This is the assertion the
      // whole sub-phase exists for.
      await openShiftAt(secondWarehouseId);

      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: secondWarehouseId,
          items: [{ variantId, quantity: 1, unitPrice: 50, serials: ['MOVED-1'] }],
          payments: [{ amount: 50 }],
        })
        .expect(201);

      expect((await serialRow('MOVED-1')).status).toBe('SOLD');
    });

    it('refuses to send a serial-tracked line without naming its units, and refuses a unit not at the source', async () => {
      const { variantId } = await receivedTrackedVariant(['GUARD-1']);
      const transferId = await transferOf(variantId, 1);

      await send(transferId, {}).expect(422);
      await send(transferId, { items: [{ variantId, serials: ['DOES-NOT-EXIST'] }] }).expect(422);

      // A unit sitting in the OTHER warehouse cannot be shipped from this one.
      const other = await receivedTrackedVariant(['ELSEWHERE-1'], secondWarehouseId);
      expect(other.variantId).toBeTruthy();
      await send(transferId, { items: [{ variantId, serials: ['ELSEWHERE-1'] }] }).expect(422);

      await send(transferId, { items: [{ variantId, serials: ['GUARD-1'] }] }).expect(200);
    });

    it('a SHORT RECEIPT leaves the missing unit IN_TRANSIT rather than absorbing it at either end', async () => {
      const { variantId } = await receivedTrackedVariant(['SHORT-1', 'SHORT-2']);
      const transferId = await transferOf(variantId, 2);
      await send(transferId, { items: [{ variantId, serials: ['SHORT-1', 'SHORT-2'] }] }).expect(200);

      // Only one unit came out of the box.
      await receiveTransfer(transferId, { items: [{ variantId, quantityReceived: 1, serials: ['SHORT-1'] }] }).expect(200);

      expect((await serialRow('SHORT-1')).currentWarehouseId).toBe(secondWarehouseId);

      // The missing unit is not quietly at the source and not quietly at
      // the destination. It is in neither, which is the truth, and the
      // discrepancy stays visible.
      const missing = await serialRow('SHORT-2');
      expect(missing.status).toBe('IN_TRANSIT');
      expect(missing.currentWarehouseId).toBeNull();
    });

    it('refuses to receive a unit this transfer never shipped', async () => {
      const first = await receivedTrackedVariant(['MINE-1']);
      const second = await receivedTrackedVariant(['THEIRS-1']);

      const transferId = await transferOf(first.variantId, 1);
      await send(transferId, { items: [{ variantId: first.variantId, serials: ['MINE-1'] }] }).expect(200);

      // A serial from an entirely different variant and shipment.
      expect(second.variantId).toBeTruthy();
      await receiveTransfer(transferId, {
        items: [{ variantId: first.variantId, quantityReceived: 1, serials: ['THEIRS-1'] }],
      }).expect(422);
    });

    it('a transfer with nothing serial-tracked still sends with no body at all', async () => {
      const variantId = await plainVariant();
      await request(app.getHttpServer())
        .post('/api/v1/inventory/opening-stock')
        .set('Authorization', auth())
        .send({ warehouseId: biz.warehouseId, variantId, quantity: 10, unitCost: 5 })
        .expect(201);

      const transferId = await transferOf(variantId, 4);
      await send(transferId, {}).expect(200);
      await receiveTransfer(transferId, { items: [{ variantId, quantityReceived: 4 }] }).expect(200);
    });
  });

  // ==================================================================
  describe('A purchase return sends the physical units back to the supplier', () => {
    const returnToSupplier = (purchaseId: string, items: Record<string, unknown>[]) =>
      request(app.getHttpServer())
        .post(`/api/v1/purchasing/purchases/${purchaseId}/returns`)
        .set('Authorization', auth())
        .send({ items });

    it('marks the returned units RETURNED_TO_SUPPLIER and owned by no warehouse', async () => {
      const { purchaseId, purchaseItemId: itemId } = await receivedTrackedVariant(['SUP-1', 'SUP-2']);

      await returnToSupplier(purchaseId, [{ purchaseItemId: itemId, quantity: 1, serials: ['SUP-1'] }]).expect(201);

      const gone = await serialRow('SUP-1');
      expect(gone.status).toBe('RETURNED_TO_SUPPLIER');
      expect(gone.currentWarehouseId).toBeNull();

      // The other unit is untouched.
      const kept = await serialRow('SUP-2');
      expect(kept.status).toBe('IN_STOCK');
      expect(kept.currentWarehouseId).toBe(biz.warehouseId);

      const links = await admin.purchaseReturnItemSerial.findMany({
        where: { businessId: biz.businessId },
        include: { serialNumber: true },
      });
      expect(links.map((l) => l.serialNumber.serial)).toContain('SUP-1');
    });

    it('is TERMINAL: a unit sent back to the supplier can never be sold, transferred, or returned again', async () => {
      const { variantId, purchaseId, purchaseItemId: itemId } = await receivedTrackedVariant(['DEAD-1', 'DEAD-2']);
      await returnToSupplier(purchaseId, [{ purchaseItemId: itemId, quantity: 1, serials: ['DEAD-1'] }]).expect(201);

      // Not sellable.
      await openShiftAt(biz.warehouseId);
      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', auth())
        .send({
          warehouseId: biz.warehouseId,
          items: [{ variantId, quantity: 1, unitPrice: 50, serials: ['DEAD-1'] }],
          payments: [{ amount: 50 }],
        })
        .expect(409);

      // Not returnable twice.
      await returnToSupplier(purchaseId, [{ purchaseItemId: itemId, quantity: 1, serials: ['DEAD-1'] }]).expect(409);

      // And the serial cannot be re-registered as if it were fresh stock,
      // which is exactly the hole a hard delete would have opened.
      const fresh = await trackedVariant();
      const p2 = await createApprovedPurchase(app, biz.accessToken, biz, [{ variantId: fresh, quantityOrdered: 1, unitCost: 10 }]);
      const i2 = await purchaseItemId(p2, fresh);
      await receive(p2, [{ purchaseItemId: i2, quantityReceived: 1, serials: ['DEAD-1'] }]).expect(409);
    });

    it('refuses a return whose serials were never in stock at that warehouse', async () => {
      const { purchaseId, purchaseItemId: itemId } = await receivedTrackedVariant(['HERE-1']);
      await returnToSupplier(purchaseId, [{ purchaseItemId: itemId, quantity: 1, serials: ['NOT-A-REAL-SERIAL'] }]).expect(422);
    });
  });

  // ==================================================================
  describe('Database-level guarantees on the three link tables', () => {
    const TABLES = ['purchase_receipt_item_serials', 'stock_transfer_item_serials', 'purchase_return_item_serials'];

    it('are APPEND-ONLY: the application role holds SELECT + INSERT and nothing else', async () => {
      for (const table of TABLES) {
        const rows: Array<{ privilege_type: string }> = await admin.$queryRawUnsafe(
          `SELECT privilege_type FROM information_schema.role_table_grants
            WHERE grantee = 'erp_app' AND table_name = $1`,
          table,
        );
        expect({ table, privileges: rows.map((r) => r.privilege_type).sort() }).toEqual({
          table,
          privileges: ['INSERT', 'SELECT'],
        });
      }
    });

    it('enforce RLS and FORCE RLS with a policy carrying BOTH halves', async () => {
      for (const table of TABLES) {
        const cls: Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }> = await admin.$queryRawUnsafe(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
          table,
        );
        expect({ table, ...cls[0] }).toEqual({ table, relrowsecurity: true, relforcerowsecurity: true });

        const policies: Array<{ qual: string | null; with_check: string | null }> = await admin.$queryRawUnsafe(
          `SELECT qual, with_check FROM pg_policies WHERE tablename = $1`,
          table,
        );
        expect(policies.length).toBe(1);
        expect(policies[0].qual).toContain('current_tenant_id');
        expect(policies[0].with_check).toContain('current_tenant_id');
      }
    });

    it('no serial is ever in two places at once: IN_STOCK implies a warehouse, everything else implies none', async () => {
      const bad: Array<{ serial: string }> = await admin.$queryRawUnsafe(
        `SELECT serial FROM serial_numbers
          WHERE (status = 'IN_STOCK' AND current_warehouse_id IS NULL)
             OR (status IN ('SOLD', 'IN_TRANSIT', 'RETURNED_TO_SUPPLIER') AND current_warehouse_id IS NOT NULL)`,
      );
      expect(bad).toEqual([]);
    });
  });
});
