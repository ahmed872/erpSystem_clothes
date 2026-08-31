import { AccountingMappingKey, AccountType, NormalBalance } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';

interface SystemAccountSeed {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  parentCode?: string;
  mappingKey?: AccountingMappingKey;
}

/**
 * Default Chart of Accounts for a fresh business - a real, if minimal,
 * hierarchy (5 top-level groups, 16 leaf accounts) covering every
 * AccountingMappingKey Phase 6's automatic postings need. "Opening
 * Balance Equity" (3100) is seeded for completeness/future manual use
 * but deliberately has NO mapping key - Phase 6 does not post an
 * automatic entry for Opening Stock (see PROJECT_STATE.md Known Issues -
 * a deliberate, documented scope boundary, not an oversight).
 */
const SYSTEM_ACCOUNTS: SystemAccountSeed[] = [
  { code: '1000', name: 'Assets', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1010', name: 'Cash on Hand', type: 'ASSET', normalBalance: 'DEBIT', parentCode: '1000', mappingKey: 'TENDER_CASH' },
  { code: '1020', name: 'Card Clearing', type: 'ASSET', normalBalance: 'DEBIT', parentCode: '1000', mappingKey: 'TENDER_CARD' },
  { code: '1030', name: 'Digital Wallet Receivable', type: 'ASSET', normalBalance: 'DEBIT', parentCode: '1000', mappingKey: 'TENDER_WALLET' },
  { code: '1040', name: 'Bank Account', type: 'ASSET', normalBalance: 'DEBIT', parentCode: '1000', mappingKey: 'TENDER_BANK_TRANSFER' },
  { code: '1050', name: 'Cheques Clearing', type: 'ASSET', normalBalance: 'DEBIT', parentCode: '1000', mappingKey: 'TENDER_CHEQUE' },
  { code: '1060', name: 'Other Tender Clearing', type: 'ASSET', normalBalance: 'DEBIT', parentCode: '1000', mappingKey: 'TENDER_OTHER' },
  // Phase 10 (Exchanges): the clearing account the two halves of an
  // exchange meet in. The return credits it and the replacement sale
  // debits it by the same figure, so a completed exchange leaves it at
  // exactly zero - which is what makes a non-zero balance here a real
  // signal rather than ordinary noise.
  { code: '1070', name: 'Exchange Clearing', type: 'ASSET', normalBalance: 'DEBIT', parentCode: '1000', mappingKey: 'EXCHANGE_CLEARING' },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET', normalBalance: 'DEBIT', parentCode: '1000', mappingKey: 'ACCOUNTS_RECEIVABLE' },
  { code: '1200', name: 'Inventory', type: 'ASSET', normalBalance: 'DEBIT', parentCode: '1000', mappingKey: 'INVENTORY_ASSET' },
  { code: '2000', name: 'Liabilities', type: 'LIABILITY', normalBalance: 'CREDIT' },
  { code: '2100', name: 'Accounts Payable', type: 'LIABILITY', normalBalance: 'CREDIT', parentCode: '2000', mappingKey: 'ACCOUNTS_PAYABLE' },
  { code: '2200', name: 'Tax Payable', type: 'LIABILITY', normalBalance: 'CREDIT', parentCode: '2000', mappingKey: 'TAX_PAYABLE' },
  { code: '3000', name: 'Equity', type: 'EQUITY', normalBalance: 'CREDIT' },
  { code: '3100', name: 'Opening Balance Equity', type: 'EQUITY', normalBalance: 'CREDIT', parentCode: '3000' },
  { code: '4000', name: 'Revenue', type: 'REVENUE', normalBalance: 'CREDIT' },
  { code: '4100', name: 'Sales Revenue', type: 'REVENUE', normalBalance: 'CREDIT', parentCode: '4000', mappingKey: 'SALES_REVENUE' },
  { code: '4200', name: 'Inventory Gain / Correction', type: 'REVENUE', normalBalance: 'CREDIT', parentCode: '4000', mappingKey: 'INVENTORY_GAIN' },
  { code: '5000', name: 'Expenses', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '5100', name: 'Cost of Goods Sold', type: 'EXPENSE', normalBalance: 'DEBIT', parentCode: '5000', mappingKey: 'COGS' },
  { code: '5200', name: 'Inventory Shrinkage / Write-off', type: 'EXPENSE', normalBalance: 'DEBIT', parentCode: '5000', mappingKey: 'INVENTORY_SHRINKAGE' },
  { code: '5300', name: 'Internal Consumption Expense', type: 'EXPENSE', normalBalance: 'DEBIT', parentCode: '5000', mappingKey: 'INTERNAL_CONSUMPTION_EXPENSE' },
  // Phase 10 (BD-17 rule 8): the CONFIGURABLE cash variance account. A
  // shortage debits it, an overage credits it. One account for both
  // directions, matching the approved policy's wording ("a configurable
  // accounting account", singular) and standard cash over/short practice -
  // deliberately unlike the shrinkage/gain PAIR used for inventory, where
  // the two directions carry genuinely different operational meaning.
  // Businesses that want their own account only have to remap the key.
  { code: '5400', name: 'Cash Over / Short', type: 'EXPENSE', normalBalance: 'DEBIT', parentCode: '5000', mappingKey: 'CASH_VARIANCE' },
];

/**
 * Idempotent: safe to call more than once for the same business (upsert
 * by (businessId, code) / (businessId, key)). Used by two callers:
 *   1. RegisterBusinessUseCase - for every NEW business, inside its own
 *      onboarding transaction.
 *   2. prisma/seed.ts - a ONE-TIME bootstrap for every business that
 *      already existed before Phase 6 shipped, so their very next Sale/
 *      Purchase/etc. can post immediately. This is infrastructure setup
 *      (a chart of accounts + mapping rules + one open period to post
 *      INTO going forward), never a reinterpretation of historical data -
 *      no journal entries are created here, and none ever will be for
 *      anything that happened before this function's first run for a
 *      given business (Phase 6 scope decision: no historical backfill).
 *
 * The bootstrap FiscalPeriod is deliberately open-ended (far-future
 * endDate) rather than a calendar month/year - the Accountant closes it
 * at whatever cutoff they choose and opens the next one via the normal
 * period endpoints, exactly like ongoing period management from then on.
 */
export async function seedAccountingDefaults(tx: TenantTx, businessId: string, actorUserId?: string, bootstrapDate: Date = new Date()): Promise<void> {
  const codeToId = new Map<string, string>();

  for (const seed of SYSTEM_ACCOUNTS) {
    const parentAccountId = seed.parentCode ? codeToId.get(seed.parentCode) : undefined;
    const account = await tx.account.upsert({
      where: { businessId_code: { businessId, code: seed.code } },
      update: {},
      create: {
        businessId,
        code: seed.code,
        name: seed.name,
        type: seed.type,
        normalBalance: seed.normalBalance,
        parentAccountId,
        isSystemAccount: true,
        createdBy: actorUserId,
      },
    });
    codeToId.set(seed.code, account.id);

    if (seed.mappingKey) {
      await tx.accountingMappingRule.upsert({
        where: { businessId_key: { businessId, key: seed.mappingKey } },
        update: {},
        create: { businessId, key: seed.mappingKey, accountId: account.id },
      });
    }
  }

  const hasOpenPeriod = await tx.fiscalPeriod.findFirst({ where: { businessId, status: 'OPEN' } });
  if (!hasOpenPeriod) {
    await tx.fiscalPeriod.create({
      data: {
        businessId,
        name: 'Open Period',
        startDate: bootstrapDate,
        endDate: new Date('9999-12-31T23:59:59.999Z'),
        status: 'OPEN',
        createdBy: actorUserId,
      },
    });
  }
}
