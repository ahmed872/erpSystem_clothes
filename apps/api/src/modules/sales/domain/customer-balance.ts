import { Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';

/**
 * A customer's balance is NEVER a stored, directly-editable number - it
 * is always SUM(CustomerTransaction.amount) for that customer, computed
 * on read, mirroring SupplierTransaction (Phase 4) exactly. Positive =
 * the customer owes the business; negative would mean the business owes
 * the customer (e.g. an overpayment or return credit exceeding what they
 * currently owe).
 */
export async function getCustomerBalance(tx: TenantTx, businessId: string, customerId: string): Promise<Prisma.Decimal> {
  const result = await tx.customerTransaction.aggregate({
    where: { businessId, customerId },
    _sum: { amount: true },
  });
  return result._sum.amount ?? new Prisma.Decimal(0);
}
