import { Prisma } from '@prisma/client';
import { ValidationFailedError } from '../../../common/errors/domain-error';

export interface ProductUomLike {
  uomId: string;
  conversionFactor: Prisma.Decimal;
}

/**
 * Converts a quantity entered in `uomId` (e.g. "5 Cartons") into the
 * variant's base UOM for ledger storage (Phase 0 §7: inventory is always
 * tracked internally in base UOM). Omitting `uomId` (or passing the
 * product's own base UOM) is a no-op - the base UOM's factor is always
 * implicit 1 and is never itself a ProductUom row (see Phase 2 schema).
 */
export function toBaseQuantity(
  baseUomId: string,
  productUoms: ProductUomLike[],
  uomId: string | undefined,
  quantity: Prisma.Decimal.Value,
): Prisma.Decimal {
  const qty = new Prisma.Decimal(quantity);
  if (!uomId || uomId === baseUomId) return qty;

  const match = productUoms.find((pu) => pu.uomId === uomId);
  if (!match) {
    throw new ValidationFailedError('This UOM is not configured for this product; add it via POST /catalog/products/:id/uoms first');
  }
  return qty.times(match.conversionFactor);
}

/** Converts a per-entered-uom cost (e.g. "$120 per Carton") to a per-base-unit cost. */
export function toBaseUnitCost(
  baseUomId: string,
  productUoms: ProductUomLike[],
  uomId: string | undefined,
  costPerUom: Prisma.Decimal.Value,
): Prisma.Decimal {
  const cost = new Prisma.Decimal(costPerUom);
  if (!uomId || uomId === baseUomId) return cost;

  const match = productUoms.find((pu) => pu.uomId === uomId);
  if (!match) {
    throw new ValidationFailedError('This UOM is not configured for this product; add it via POST /catalog/products/:id/uoms first');
  }
  return cost.dividedBy(match.conversionFactor);
}
