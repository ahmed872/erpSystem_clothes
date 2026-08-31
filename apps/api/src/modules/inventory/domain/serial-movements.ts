import { Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { ConflictDomainError, ValidationFailedError } from '../../../common/errors/domain-error';
import { assertSerialCountMatchesQuantity } from './lot-and-serial';

/**
 * Phase 10 (10D) — moving a serial-tracked unit between the places it can
 * be, other than a sale.
 *
 * THE DEFECT THIS FILE EXISTS TO CLOSE. Before Phase 10, a stock transfer
 * moved quantities and ignored serials entirely. The unit's row kept
 * pointing at the warehouse it had physically left, so it could not be
 * sold at the destination (`not IN_STOCK at this warehouse`) and could not
 * be sold at the source either (the stock had gone). Serial-tracked stock
 * was, in practice, untransferable — a silent one, because the transfer
 * itself succeeded and only the later sale failed.
 *
 * The lifecycle these functions complete:
 *
 *   (register)  ──> IN_STOCK ──sale──> SOLD
 *                      │  ▲
 *              send ───┘  └─── receive
 *                      ▼
 *                 IN_TRANSIT
 *                      │
 *   IN_STOCK ──supplier return──> RETURNED_TO_SUPPLIER  (terminal)
 *
 * CONCURRENCY. Every function here takes its rows with
 * `SELECT ... FOR UPDATE` in deterministic `id` order — the same ordering
 * the sale and sale-return paths use, so an overlapping set can never be
 * grabbed in opposite orders and deadlock. This is the SerialNumber step
 * of the canonical lock order Customer -> Sale -> StockBalance ->
 * SerialNumber.
 */

interface LockedSerialRow {
  id: string;
  serial: string;
  status: string;
  current_warehouse_id: string | null;
}

/**
 * IN_STOCK at the source -> IN_TRANSIT, owned by no warehouse.
 *
 * `currentWarehouseId` is cleared deliberately. Goods in a van belong to
 * neither end, and leaving them pointed at the source would let the same
 * unit be sold out from under a transfer that has already shipped it.
 */
export async function shipSerialsOnTransfer(
  tx: TenantTx,
  businessId: string,
  variantId: string,
  sourceWarehouseId: string,
  serials: string[] | undefined,
  quantity: Prisma.Decimal.Value,
): Promise<string[]> {
  if (assertSerialCountMatchesQuantity(serials, quantity) === 0) return [];

  const rows = await tx.$queryRawUnsafe<LockedSerialRow[]>(
    `SELECT id, serial, status::text AS status, current_warehouse_id
       FROM serial_numbers
      WHERE business_id = $1 AND variant_id = $2 AND serial = ANY($3::text[])
      ORDER BY id
        FOR UPDATE`,
    businessId,
    variantId,
    serials,
  );
  if (rows.length !== serials!.length) {
    throw new ValidationFailedError('One or more serials do not exist for this variant', { variantId });
  }
  const notAvailable = rows.find((r) => r.status !== 'IN_STOCK' || r.current_warehouse_id !== sourceWarehouseId);
  if (notAvailable) {
    throw new ConflictDomainError(`Serial ${notAvailable.serial} is not IN_STOCK at the source warehouse`, {
      serial: notAvailable.serial,
      status: notAvailable.status,
    });
  }

  const ids = rows.map((r) => r.id);
  await tx.serialNumber.updateMany({ where: { id: { in: ids } }, data: { status: 'IN_TRANSIT', currentWarehouseId: null } });
  return ids;
}

/**
 * IN_TRANSIT -> IN_STOCK at the destination.
 *
 * The join against `stock_transfer_item_serials` is the check: a unit
 * this transfer never shipped simply does not come back from the query,
 * so a receiving clerk cannot quietly add stock that was never sent.
 *
 * A SHORT RECEIPT IS LEGITIMATE and is why this takes the serials rather
 * than deriving them from the shipment. When fewer units arrive than were
 * sent, the ones that did not arrive STAY IN_TRANSIT: that is the honest
 * record — they are neither at the source nor at the destination, and the
 * discrepancy stays visible instead of being quietly absorbed at one end.
 */
export async function receiveSerialsOnTransfer(
  tx: TenantTx,
  businessId: string,
  stockTransferItemId: string,
  destinationWarehouseId: string,
  serials: string[] | undefined,
  quantityReceived: Prisma.Decimal.Value,
): Promise<string[]> {
  if (assertSerialCountMatchesQuantity(serials, quantityReceived) === 0) return [];

  const rows = await tx.$queryRawUnsafe<LockedSerialRow[]>(
    `SELECT sn.id, sn.serial, sn.status::text AS status, sn.current_warehouse_id
       FROM serial_numbers sn
       JOIN stock_transfer_item_serials stis
         ON stis.serial_number_id = sn.id
        AND stis.stock_transfer_item_id = $2
        AND stis.business_id = $1
      WHERE sn.business_id = $1 AND sn.serial = ANY($3::text[])
      ORDER BY sn.id
        FOR UPDATE OF sn`,
    businessId,
    stockTransferItemId,
    serials,
  );
  if (rows.length !== serials!.length) {
    throw new ValidationFailedError('One or more serials were not shipped on this transfer line and cannot be received against it', {
      stockTransferItemId,
    });
  }
  const notInTransit = rows.find((r) => r.status !== 'IN_TRANSIT');
  if (notInTransit) {
    throw new ConflictDomainError(`Serial ${notInTransit.serial} is not in transit`, {
      serial: notInTransit.serial,
      status: notInTransit.status,
    });
  }

  const ids = rows.map((r) => r.id);
  await tx.serialNumber.updateMany({
    where: { id: { in: ids } },
    data: { status: 'IN_STOCK', currentWarehouseId: destinationWarehouseId },
  });
  return ids;
}

/**
 * IN_STOCK -> RETURNED_TO_SUPPLIER, owned by no warehouse.
 *
 * Terminal on purpose. The unit is no longer the business's to sell, and
 * the row is kept rather than deleted so the serial can never be
 * re-registered later as though it were fresh stock — which is exactly
 * the hole a delete would open.
 */
export async function returnSerialsToSupplier(
  tx: TenantTx,
  businessId: string,
  variantId: string,
  warehouseId: string,
  serials: string[] | undefined,
  quantity: Prisma.Decimal.Value,
): Promise<string[]> {
  if (assertSerialCountMatchesQuantity(serials, quantity) === 0) return [];

  const rows = await tx.$queryRawUnsafe<LockedSerialRow[]>(
    `SELECT id, serial, status::text AS status, current_warehouse_id
       FROM serial_numbers
      WHERE business_id = $1 AND variant_id = $2 AND serial = ANY($3::text[])
      ORDER BY id
        FOR UPDATE`,
    businessId,
    variantId,
    serials,
  );
  if (rows.length !== serials!.length) {
    throw new ValidationFailedError('One or more serials do not exist for this variant', { variantId });
  }
  const notAvailable = rows.find((r) => r.status !== 'IN_STOCK' || r.current_warehouse_id !== warehouseId);
  if (notAvailable) {
    throw new ConflictDomainError(`Serial ${notAvailable.serial} is not IN_STOCK at this warehouse and cannot go back to the supplier`, {
      serial: notAvailable.serial,
      status: notAvailable.status,
    });
  }

  const ids = rows.map((r) => r.id);
  await tx.serialNumber.updateMany({
    where: { id: { in: ids } },
    data: { status: 'RETURNED_TO_SUPPLIER', currentWarehouseId: null },
  });
  return ids;
}
