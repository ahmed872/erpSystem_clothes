import { AccountingMappingKey, Prisma, SalePaymentMethod } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { PostEntryLineInput } from '../../../engines/accounting/accounting-engine.service';
import { resolveMappedAccounts } from './resolve-mapped-account';

const SALE_TENDER_KEY: Record<SalePaymentMethod, AccountingMappingKey> = {
  CASH: 'TENDER_CASH',
  CARD: 'TENDER_CARD',
  WALLET: 'TENDER_WALLET',
  OTHER: 'TENDER_OTHER',
};

/** A later payment against a credit sale: Dr the tender account, Cr
 * Accounts Receivable - the exact mirror of the SalePayment/
 * CustomerTransaction(PAYMENT) row CreateSalePaymentUseCase already
 * writes. */
export async function buildSalePaymentJournalLines(tx: TenantTx, businessId: string, amount: Prisma.Decimal, method: SalePaymentMethod): Promise<PostEntryLineInput[]> {
  if (!amount.greaterThan(0)) return [];
  const accounts = await resolveMappedAccounts(tx, businessId, [SALE_TENDER_KEY[method], 'ACCOUNTS_RECEIVABLE']);
  return [
    { accountId: accounts.get(SALE_TENDER_KEY[method])!, debit: amount, description: `Tender: ${method}` },
    { accountId: accounts.get('ACCOUNTS_RECEIVABLE')!, credit: amount, description: 'Customer payment against sale' },
  ];
}
