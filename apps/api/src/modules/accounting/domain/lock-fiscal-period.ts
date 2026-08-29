import { TenantTx } from '../../../common/prisma/prisma.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../common/errors/domain-error';

interface FiscalPeriodRow {
  id: string;
  status: string;
}

/**
 * Resolves the FiscalPeriod covering `entryDate` and locks its row with
 * `SELECT ... FOR UPDATE`, serializing against a concurrent
 * ClosePeriodUseCase/ReopenPeriodUseCase call for the SAME period - the
 * exact mechanism the "period-close vs posting concurrency" invariant
 * needs: whichever side acquires the lock first wins, the other either
 * sees the just-committed CLOSED status (and is rejected) or blocks until
 * the posting commits before it can flip the period closed. Requires the
 * `UPDATE` grant on fiscal_periods for the same Postgres-mechanical
 * reason `lockSale`/`lockPurchase` do (Phase 5's lesson, applied here
 * from the start instead of discovered live).
 *
 * Used by both AccountingEngineService.postEntry (validates the period
 * is OPEN before posting) and ClosePeriodUseCase/ReopenPeriodUseCase
 * (validates+locks the SAME row before flipping status), so the two
 * operations can never race into an inconsistent state.
 */
export async function lockFiscalPeriodCoveringDate(tx: TenantTx, businessId: string, entryDate: Date): Promise<FiscalPeriodRow> {
  const rows = await tx.$queryRawUnsafe<FiscalPeriodRow[]>(
    `SELECT id, status FROM fiscal_periods
     WHERE business_id = $1 AND start_date <= $2 AND end_date >= $2
     ORDER BY start_date DESC
     LIMIT 1
     FOR UPDATE`,
    businessId,
    entryDate,
  );
  if (rows.length === 0) {
    throw new ConflictDomainError('No fiscal period covers this date - open one before posting', { entryDate: entryDate.toISOString() });
  }
  return rows[0];
}

export async function lockFiscalPeriodById(tx: TenantTx, businessId: string, periodId: string): Promise<FiscalPeriodRow> {
  const rows = await tx.$queryRawUnsafe<FiscalPeriodRow[]>(
    `SELECT id, status FROM fiscal_periods WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    periodId,
    businessId,
  );
  if (rows.length === 0) {
    throw new NotFoundDomainError('FiscalPeriod', periodId);
  }
  return rows[0];
}
