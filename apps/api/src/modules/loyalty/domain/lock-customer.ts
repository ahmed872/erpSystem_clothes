import { TenantTx } from '../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../common/errors/domain-error';

interface LockedIdRow {
  id: string;
}

/**
 * Locks the Customer row with `SELECT ... FOR UPDATE` before reading a
 * loyalty balance that is about to be spent against.
 *
 * Why the CUSTOMER row and not the ledger rows: the balance is
 * `SUM(customer_points)`, and the danger under concurrency is two
 * requests each reading the same balance and each INSERTing a debit that
 * is individually affordable but jointly overdrawn. Locking the existing
 * ledger rows cannot prevent that - a row lock does not block the INSERT
 * of a NEW row. The customer is the one row every such operation must
 * pass through, so it is the correct serialization point, exactly as
 * `lockSale` serializes returns and payments against one Sale.
 *
 * `customers` already carries the UPDATE grant from Phase 5, which
 * PostgreSQL requires for `FOR UPDATE` even when no write follows (the
 * Known Issue #30 lesson), so this needs no new grant.
 */
export async function lockCustomer(tx: TenantTx, businessId: string, customerId: string): Promise<void> {
  const rows = await tx.$queryRawUnsafe<LockedIdRow[]>(
    `SELECT id FROM customers WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    customerId,
    businessId,
  );
  if (rows.length === 0) throw new NotFoundDomainError('Customer', customerId);
}
