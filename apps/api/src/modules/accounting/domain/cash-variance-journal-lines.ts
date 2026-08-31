import { Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { PostEntryLineInput } from '../../../engines/accounting/accounting-engine.service';
import { resolveMappedAccounts } from './resolve-mapped-account';

/**
 * Phase 10 (BD-17 rules 7 and 8) — the blind-close cash variance.
 *
 * `variance = countedCash - expectedCash`, where expected is derived from
 * the opening float and the shift's own append-only movement ledger.
 *
 *   variance < 0  SHORTAGE. The drawer holds less than the documents say
 *                 it should, so the Cash account is overstated: CREDIT
 *                 Cash to bring it down to what is physically there, and
 *                 DEBIT the variance account (a loss).
 *
 *   variance > 0  OVERAGE. The drawer holds more than the documents
 *                 account for: DEBIT Cash and CREDIT the variance account
 *                 (a gain).
 *
 * BD-17 rule 8 requires the variance account to be CONFIGURABLE rather
 * than a hard-coded name, so it is resolved through `AccountingMappingRule`
 * exactly like every other account in the system - a business that wants
 * its own Cash Over/Short account only has to remap the key.
 *
 * A single key is used for both directions, per the approved policy's
 * wording ("a configurable accounting account", singular). That is standard
 * practice for cash over/short and differs deliberately from the
 * shrinkage/gain pair used for inventory, where the two directions carry
 * genuinely different operational meaning.
 *
 * A zero variance posts NOTHING. An entry with two zero lines would be
 * noise in the ledger and would trip the debit-xor-credit constraint; a
 * drawer that balances is simply a drawer that balances.
 */
export async function buildCashVarianceJournalLines(
  tx: TenantTx,
  businessId: string,
  variance: Prisma.Decimal,
): Promise<PostEntryLineInput[]> {
  if (variance.isZero()) return [];

  const accounts = await resolveMappedAccounts(tx, businessId, ['TENDER_CASH', 'CASH_VARIANCE']);
  const cashAccountId = accounts.get('TENDER_CASH')!;
  const varianceAccountId = accounts.get('CASH_VARIANCE')!;
  const magnitude = variance.abs();

  if (variance.isNegative()) {
    return [
      { accountId: varianceAccountId, debit: magnitude, description: 'Cash shortage at shift close' },
      { accountId: cashAccountId, credit: magnitude, description: 'Cash shortage at shift close' },
    ];
  }

  return [
    { accountId: cashAccountId, debit: magnitude, description: 'Cash overage at shift close' },
    { accountId: varianceAccountId, credit: magnitude, description: 'Cash overage at shift close' },
  ];
}
