import { Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { ConflictDomainError, ValidationFailedError } from '../../../common/errors/domain-error';

/** Finds or creates the lot registry row for a lot number, returning its id.
 * Lot rows carry NO quantity - "how much of this lot remains" is always
 * `SUM(quantity_base) WHERE lot_id = X` against stock_movements. */
export async function resolveOrCreateLot(
  tx: TenantTx,
  businessId: string,
  variantId: string,
  lotNumber: string | undefined,
  expiryDate: string | undefined,
  manufacturingDate: string | undefined,
): Promise<string | undefined> {
  if (!lotNumber) return undefined;

  const existing = await tx.inventoryLot.findUnique({
    where: { businessId_variantId_lotNumber: { businessId, variantId, lotNumber } },
  });
  if (existing) return existing.id;

  const created = await tx.inventoryLot.create({
    data: {
      businessId,
      variantId,
      lotNumber,
      expiryDate: expiryDate ? new Date(expiryDate) : undefined,
      manufacturingDate: manufacturingDate ? new Date(manufacturingDate) : undefined,
    },
  });
  return created.id;
}

/**
 * Validates the serial count matches the (integer) quantity being
 * received and that none already exist, then registers them as IN_STOCK,
 * returning their ids so the caller can record which document brought
 * each unit in.
 *
 * PRE-EXISTING DEFECT FIXED IN PHASE 10 (10D). This used to return
 * silently when `serials` was empty, even though every caller only
 * reaches it for a variant whose product IS serial-tracked. The effect
 * was that a serial-tracked variant could be received with no serials at
 * all: stock went up, no unit was registered, and the goods were then
 * unsellable, because the sale path (BD-13) requires a serial per unit
 * and there were none to give. Serials are now MANDATORY at every point
 * of receipt, which is the same rule BD-13 already applied to the sale.
 */
export async function createSerialsForReceipt(
  tx: TenantTx,
  businessId: string,
  variantId: string,
  warehouseId: string,
  serials: string[] | undefined,
  quantity: Prisma.Decimal.Value,
): Promise<string[]> {
  const count = assertSerialCountMatchesQuantity(serials, quantity);
  if (count === 0) return [];
  const list = serials!;

  const existing = await tx.serialNumber.findMany({ where: { businessId, serial: { in: list } }, select: { serial: true } });
  if (existing.length > 0) {
    throw new ConflictDomainError(`Serial number already registered: ${existing[0].serial}`);
  }

  await tx.serialNumber.createMany({
    data: list.map((serial) => ({ businessId, variantId, serial, status: 'IN_STOCK', currentWarehouseId: warehouseId })),
  });

  const created = await tx.serialNumber.findMany({
    where: { businessId, variantId, serial: { in: list } },
    select: { id: true },
  });
  return created.map((r) => r.id);
}

/**
 * The one rule every serial-carrying document obeys: exactly one serial
 * per unit, no duplicates, and a whole number of units.
 *
 * Shared rather than repeated so that receiving, selling, transferring
 * and returning to a supplier can never drift into disagreeing about what
 * "one unit, one serial" means. Returns the count so a caller can
 * distinguish "nothing to do" from "a mismatch".
 */
export function assertSerialCountMatchesQuantity(serials: string[] | undefined, quantity: Prisma.Decimal.Value): number {
  const qty = new Prisma.Decimal(quantity);
  const count = serials?.length ?? 0;
  if (qty.isZero() && count === 0) return 0;

  if (!qty.isInteger()) {
    throw new ValidationFailedError('A serial-tracked variant can only move in whole units', { quantity: qty.toString() });
  }
  if (!qty.equals(count)) {
    throw new ValidationFailedError('The number of serials provided must equal the quantity for a serial-tracked variant', {
      quantity: qty.toString(),
      serialsProvided: count,
    });
  }
  if (new Set(serials).size !== count) {
    throw new ValidationFailedError('Duplicate serial number in request');
  }
  return count;
}

/**
 * The mirror rule: a variant that is NOT serial-tracked cannot be given
 * serials. Only the server knows a product's tracking flag, so this is
 * decided here rather than trusted from the request - the same posture
 * BD-13 established on the sale path.
 */
export function assertNoSerialsForUntrackedVariant(serials: string[] | undefined, variantId: string): void {
  if (serials && serials.length > 0) {
    throw new ValidationFailedError('Serial numbers were supplied for a variant that is not serial-tracked', { variantId });
  }
}

interface LockedSerialRow {
  id: string;
  serial: string;
  status: string;
  current_warehouse_id: string | null;
}

/**
 * Validates and consumes (marks SOLD) the given serials for a sale,
 * returning the ids of the units actually consumed so the caller can
 * record WHICH physical unit left on WHICH sale line (Phase 8E).
 *
 * CONCURRENCY (Phase 8E): the candidate rows are taken with
 * `SELECT ... FOR UPDATE`, in a deterministic order, BEFORE their status
 * is read. Without the lock this was a read-then-write race - two
 * simultaneous sales could each see the same unit as IN_STOCK and both
 * mark it SOLD, selling one physical item twice. Ordering the lock by
 * `id` means two sales requesting an overlapping set can never grab them
 * in opposite orders and deadlock.
 *
 * `serial_numbers` already carries the UPDATE privilege from Phase 3, and
 * PostgreSQL requires exactly that for `FOR UPDATE`, so this needs no new
 * grant.
 */
export async function consumeSerialsForSale(
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
    throw new ValidationFailedError('One or more serials do not exist for this variant');
  }
  const notAvailable = rows.find((r) => r.status !== 'IN_STOCK' || r.current_warehouse_id !== warehouseId);
  if (notAvailable) {
    throw new ConflictDomainError(`Serial ${notAvailable.serial} is not IN_STOCK at this warehouse`);
  }

  const ids = rows.map((r) => r.id);
  await tx.serialNumber.updateMany({ where: { id: { in: ids } }, data: { status: 'SOLD', currentWarehouseId: null } });
  return ids;
}
