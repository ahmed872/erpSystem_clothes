import { TenantTx } from '../../../common/prisma/prisma.service';
import { ConflictDomainError, ValidationFailedError } from '../../../common/errors/domain-error';

interface LockedSerialRow {
  id: string;
  serial: string;
  status: string;
}

/**
 * Transitions returned serial-tracked units out of SOLD, into the
 * disposition the return recorded for them (approved decision BD-22).
 *
 *   SELLABLE -> IN_STOCK, back at the warehouse that took them
 *   DAMAGED  -> DAMAGED, owned by no warehouse
 *
 * WHY THIS CHANGED IN PHASE 10. Phase 8E sent every returned unit to a
 * RETURNED quarantine state on the way to a future inspection workflow.
 * That workflow was deferred, and the consequence was that the QUANTITY
 * came back into sellable stock (a SELLABLE return posts a real
 * SALES_RETURN increase) while the SERIAL did not. The two disagreed
 * permanently: the balance said one unit was on the shelf and the serial
 * register said it was in quarantine, so nobody could ever sell it. BD-22
 * resolves this by making the serial follow the same disposition the
 * return line already declares for the goods, which is the decision the
 * person at the counter actually makes.
 *
 * A DAMAGED return keeps `currentWarehouseId` null, matching the stock
 * side exactly: a DAMAGED return posts the SALES_RETURN increase and an
 * immediate DAMAGE decrease, so no sellable quantity remains either.
 *
 * A serial can never be returned twice: the transition is guarded by the
 * unit's own current status under a row lock, so the second attempt sees a
 * unit that is no longer SOLD and is rejected.
 *
 * CONCURRENCY: rows are taken with `SELECT ... FOR UPDATE` in
 * deterministic `id` order - the same ordering the sale path uses - so
 * two concurrent returns of the same unit serialize rather than both
 * succeeding, and two returns of an overlapping set cannot deadlock. This
 * is the SerialNumber step of the canonical system-wide lock order
 * Customer -> Sale -> StockBalance -> SerialNumber.
 *
 * Returns the ids transitioned, so the caller can void any warranty
 * covering them.
 */
export async function disposeReturnedSerials(
  tx: TenantTx,
  businessId: string,
  saleItemId: string,
  serials: string[],
  condition: 'SELLABLE' | 'DAMAGED',
  warehouseId: string,
): Promise<string[]> {
  if (serials.length === 0) return [];
  if (new Set(serials).size !== serials.length) {
    throw new ValidationFailedError('Duplicate serial number in return request');
  }

  const rows = await tx.$queryRawUnsafe<LockedSerialRow[]>(
    `SELECT sn.id, sn.serial, sn.status::text AS status
       FROM serial_numbers sn
       JOIN sale_item_serials sis
         ON sis.serial_number_id = sn.id
        AND sis.sale_item_id = $2
        AND sis.business_id = $1
      WHERE sn.business_id = $1 AND sn.serial = ANY($3::text[])
      ORDER BY sn.id
        FOR UPDATE OF sn`,
    businessId,
    saleItemId,
    serials,
  );

  // The join is the check: a serial this sale line never sold simply does
  // not come back, so a customer cannot return a unit they did not buy
  // here.
  if (rows.length !== serials.length) {
    throw new ValidationFailedError('One or more serials were not sold on this sale line and cannot be returned against it', {
      saleItemId,
    });
  }

  const alreadyBack = rows.find((r) => r.status !== 'SOLD');
  if (alreadyBack) {
    throw new ConflictDomainError(`Serial ${alreadyBack.serial} has already been returned`, {
      serial: alreadyBack.serial,
      status: alreadyBack.status,
    });
  }

  const ids = rows.map((r) => r.id);
  await tx.serialNumber.updateMany({
    where: { id: { in: ids } },
    data:
      condition === 'DAMAGED'
        ? { status: 'DAMAGED', currentWarehouseId: null }
        : { status: 'IN_STOCK', currentWarehouseId: warehouseId },
  });
  return ids;
}
