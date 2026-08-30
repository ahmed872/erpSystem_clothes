import { TenantTx } from '../../../common/prisma/prisma.service';
import { ConflictDomainError, ValidationFailedError } from '../../../common/errors/domain-error';

interface LockedSerialRow {
  id: string;
  serial: string;
  status: string;
}

/**
 * Transitions returned serial-tracked units SOLD -> RETURNED (approved
 * decision BD-14).
 *
 * RETURNED, deliberately NOT straight back to IN_STOCK: a physical item
 * coming back over the counter is not automatically known to be sellable.
 * RETURNED is the post-return quarantine state, and the intended
 * lifecycle is SOLD -> RETURNED -> (future inspection workflow) ->
 * IN_STOCK or DAMAGED. Phase 8E implements only the approved RETURNED
 * disposition and builds no inspection workflow.
 *
 * A serial can never be returned twice: the transition is guarded by the
 * unit's own current status under a row lock, so the second attempt sees
 * RETURNED and is rejected.
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
export async function returnSerialsToQuarantine(
  tx: TenantTx,
  businessId: string,
  saleItemId: string,
  serials: string[],
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
  await tx.serialNumber.updateMany({ where: { id: { in: ids } }, data: { status: 'RETURNED' } });
  return ids;
}
