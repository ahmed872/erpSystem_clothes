import { AccountingMappingKey, Prisma, PurchasePaymentMethod } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { PostEntryLineInput } from '../../../engines/accounting/accounting-engine.service';
import { resolveMappedAccounts } from './resolve-mapped-account';

const EXPENSE_TENDER_KEY: Record<PurchasePaymentMethod, AccountingMappingKey> = {
  CASH: 'TENDER_CASH',
  BANK_TRANSFER: 'TENDER_BANK_TRANSFER',
  CHEQUE: 'TENDER_CHEQUE',
  CARD: 'TENDER_CARD',
  OTHER: 'TENDER_OTHER',
};

/**
 * Phase 10 (10H) — an expense: Dr <the category's account>, Cr <tender>.
 *
 * The DEBIT side is the one thing here that is not a mapping key: it is
 * the account the BUSINESS chose for that category, because no product can
 * know what a given shop counts as rent, fuel or cleaning. The credit side
 * is the ordinary tender mapping every other money-out path already uses,
 * so an expense paid in cash and a supplier paid in cash credit the same
 * account and reconcile against the same drawer.
 *
 * Two lines, always, and they balance by construction.
 */
export async function buildExpenseJournalLines(
  tx: TenantTx,
  businessId: string,
  params: { expenseAccountId: string; method: PurchasePaymentMethod; amount: Prisma.Decimal },
): Promise<PostEntryLineInput[]> {
  if (params.amount.lessThanOrEqualTo(0)) return [];

  const tenderKey = EXPENSE_TENDER_KEY[params.method];
  const accounts = await resolveMappedAccounts(tx, businessId, [tenderKey]);

  return [
    { accountId: params.expenseAccountId, debit: params.amount, description: 'Expense' },
    { accountId: accounts.get(tenderKey)!, credit: params.amount, description: `Tender: ${params.method}` },
  ];
}
