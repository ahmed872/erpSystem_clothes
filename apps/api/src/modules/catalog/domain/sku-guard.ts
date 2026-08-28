import { TenantTx } from '../../../common/prisma/prisma.service';
import { ConflictDomainError } from '../../../common/errors/domain-error';

/**
 * SKU is a single flat lookup namespace shared across Product AND
 * ProductVariant (a POS/ERP search-by-SKU must never be ambiguous about
 * which table it hit) even though the two live in separate tables with
 * their own per-table unique constraints. This cross-table invariant
 * can't be expressed as a single DB constraint without an artificial
 * shared lookup table, so it's enforced here at the application layer,
 * called before every Product or ProductVariant insert.
 */
export async function assertSkuAvailable(tx: TenantTx, businessId: string, sku: string): Promise<void> {
  const [existingProduct, existingVariant] = await Promise.all([
    tx.product.findFirst({ where: { businessId, sku }, select: { id: true } }),
    tx.productVariant.findFirst({ where: { businessId, sku }, select: { id: true } }),
  ]);
  if (existingProduct || existingVariant) {
    throw new ConflictDomainError(`SKU "${sku}" is already in use`);
  }
}
