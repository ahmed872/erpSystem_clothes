import { TenantTx } from '../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../common/errors/domain-error';

/** Loads and validates the warehouse + variant (with its product and
 * configured non-base UOMs) for a stock operation, all scoped to the
 * caller's own tenant. Shared by every use-case that touches a specific
 * (warehouse, variant) pair, instead of re-querying ad hoc per feature. */
export async function loadVariantContext(tx: TenantTx, businessId: string, warehouseId: string, variantId: string) {
  const warehouse = await tx.warehouse.findFirst({ where: { id: warehouseId, businessId } });
  if (!warehouse) throw new NotFoundDomainError('Warehouse', warehouseId);

  const variant = await tx.productVariant.findFirst({
    where: { id: variantId, businessId },
    include: { product: { include: { productUoms: true } } },
  });
  if (!variant) throw new NotFoundDomainError('ProductVariant', variantId);

  return { warehouse, variant, product: variant.product };
}
