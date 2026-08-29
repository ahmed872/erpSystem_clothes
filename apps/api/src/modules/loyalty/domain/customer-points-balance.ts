import { Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';

/**
 * A customer's loyalty balance is NEVER a stored, directly-editable
 * number - it is ALWAYS `SUM(CustomerPoints.points)` for that customer,
 * computed on read. This mirrors `getCustomerBalance` (money) and
 * `SupplierTransaction` (Phase 4) exactly, and it is what the approved
 * Phase 8 policy requires: "Balance = SUM(CustomerPoints). لا يوجد stored
 * mutable balance."
 *
 * There is deliberately no `balance` column on `Customer` and no cache to
 * invalidate, so a balance can never drift from its own history. The
 * `customer_points` table has SELECT+INSERT only for `erp_app`, so the
 * history it is derived from cannot be rewritten either.
 *
 * Every row is signed (EARN positive; REDEEM and RETURN_CLAWBACK
 * negative; ADJUSTMENT either way), so a plain SUM is the whole
 * computation - no per-type branching, nothing to get out of step with
 * the CHECK constraint that enforces those signs.
 */
export async function getCustomerPointsBalance(
  tx: TenantTx,
  businessId: string,
  customerId: string,
): Promise<Prisma.Decimal> {
  const result = await tx.customerPoints.aggregate({
    where: { businessId, customerId },
    _sum: { points: true },
  });
  return result._sum.points ?? new Prisma.Decimal(0);
}
