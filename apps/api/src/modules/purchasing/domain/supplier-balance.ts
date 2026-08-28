import { Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';

/**
 * A supplier's balance is NEVER a stored, directly-editable number - it
 * is always SUM(SupplierTransaction.amount) for that supplier, computed
 * on read. This mirrors the Phase 3 principle that StockBalance is a
 * derived cache of StockMovement: here there isn't even a cache, since
 * suppliers don't see anywhere near the write volume stock balances do.
 * Positive = the business owes the supplier; negative would mean the
 * business has overpaid/overreturned relative to what it owes.
 */
export async function getSupplierBalance(tx: TenantTx, businessId: string, supplierId: string): Promise<Prisma.Decimal> {
  const result = await tx.supplierTransaction.aggregate({
    where: { businessId, supplierId },
    _sum: { amount: true },
  });
  return result._sum.amount ?? new Prisma.Decimal(0);
}
