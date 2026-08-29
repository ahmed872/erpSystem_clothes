import { TenantTx } from '../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../common/errors/domain-error';

interface LockedIdRow {
  id: string;
}

/**
 * Locks the Sale document row with `SELECT ... FOR UPDATE` before any
 * read/write touches its items or payments - the exact same pattern as
 * Purchasing's `lockPurchase` (Phase 4), applied to the two Sale
 * operations that mutate an EXISTING Sale's running totals under
 * concurrency: returning against it (`sale_items.quantity_returned`) and
 * recording a later payment against a credit sale (bounded by
 * `totalAmount - SUM(existing payments)`). `CreateSaleUseCase` itself
 * does NOT need this lock - it inserts a brand-new Sale row, so there is
 * nothing existing to race against.
 *
 * Locking the Sale row (not each SaleItem row individually) is
 * sufficient because every mutation to this sale's items/payments
 * happens only while holding this lock, so two concurrent
 * return-or-pay requests against the SAME sale serialize on it exactly
 * like two concurrent receive/return requests serialize on a Purchase
 * row.
 */
export async function lockSale(tx: TenantTx, businessId: string, saleId: string): Promise<void> {
  const rows = await tx.$queryRawUnsafe<LockedIdRow[]>(
    `SELECT id FROM sales WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    saleId,
    businessId,
  );
  if (rows.length === 0) throw new NotFoundDomainError('Sale', saleId);
}
