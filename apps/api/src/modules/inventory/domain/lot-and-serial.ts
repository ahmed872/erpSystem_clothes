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

/** Validates the serial count matches the (integer) quantity being
 * received and that none already exist, then registers them as IN_STOCK. */
export async function createSerialsForReceipt(
  tx: TenantTx,
  businessId: string,
  variantId: string,
  warehouseId: string,
  serials: string[] | undefined,
  quantity: number,
): Promise<void> {
  if (!serials || serials.length === 0) return;

  if (!Number.isInteger(quantity) || serials.length !== quantity) {
    throw new ValidationFailedError('The number of serials provided must equal the quantity for a serial-tracked variant');
  }
  if (new Set(serials).size !== serials.length) {
    throw new ValidationFailedError('Duplicate serial number in request');
  }

  const existing = await tx.serialNumber.findMany({ where: { businessId, serial: { in: serials } }, select: { serial: true } });
  if (existing.length > 0) {
    throw new ConflictDomainError(`Serial number already registered: ${existing[0].serial}`);
  }

  await tx.serialNumber.createMany({
    data: serials.map((serial) => ({ businessId, variantId, serial, status: 'IN_STOCK', currentWarehouseId: warehouseId })),
  });
}

/** Validates and consumes (marks SOLD) the given serials for a sale. */
export async function consumeSerialsForSale(
  tx: TenantTx,
  businessId: string,
  variantId: string,
  warehouseId: string,
  serials: string[] | undefined,
  quantity: number,
): Promise<void> {
  if (!serials || serials.length === 0) return;

  if (!Number.isInteger(quantity) || serials.length !== quantity) {
    throw new ValidationFailedError('The number of serials provided must equal the quantity for a serial-tracked variant');
  }

  const rows = await tx.serialNumber.findMany({ where: { businessId, variantId, serial: { in: serials } } });
  if (rows.length !== serials.length) {
    throw new ValidationFailedError('One or more serials do not exist for this variant');
  }
  const notAvailable = rows.find((r) => r.status !== 'IN_STOCK' || r.currentWarehouseId !== warehouseId);
  if (notAvailable) {
    throw new ConflictDomainError(`Serial ${notAvailable.serial} is not IN_STOCK at this warehouse`);
  }

  await tx.serialNumber.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status: 'SOLD', currentWarehouseId: null },
  });
}
