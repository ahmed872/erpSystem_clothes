import { TenantTx } from '../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../common/errors/domain-error';

interface LockedIdRow {
  id: string;
}

/**
 * Locks the Purchase document row with `SELECT ... FOR UPDATE` before any
 * read/write touches it or its items. This is the lock target for the
 * DOCUMENT-level "how much of this PO has been received/returned"
 * invariant - deliberately separate from, and in addition to, the
 * Inventory Engine's own StockBalance row lock (see
 * engines/inventory/inventory-engine.service.ts), because that lock
 * protects stock correctness for a (warehouse, variant) pair, not the
 * over-receiving/over-returning invariant of a specific Purchase
 * document.
 *
 * Locking the Purchase row is sufficient (no need to separately lock
 * every PurchaseItem row) because every mutation to this purchase's
 * items happens only while holding this lock - receiving, returning, and
 * editing all go through this same function first. Two concurrent
 * receive (or return) requests against the SAME purchase therefore
 * serialize on it exactly like two concurrent sales serialize on a
 * StockBalance row: the second transaction's FOR UPDATE blocks until the
 * first commits, so it always recomputes "how much is left to receive"
 * from the first one's already-applied change.
 */
export async function lockPurchase(tx: TenantTx, businessId: string, purchaseId: string): Promise<void> {
  const rows = await tx.$queryRawUnsafe<LockedIdRow[]>(
    `SELECT id FROM purchases WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    purchaseId,
    businessId,
  );
  if (rows.length === 0) throw new NotFoundDomainError('Purchase', purchaseId);
}
