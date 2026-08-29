import { AccountingMappingKey, Prisma, PurchasePaymentMethod } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { PostEntryLineInput } from '../../../engines/accounting/accounting-engine.service';
import { resolveMappedAccounts } from './resolve-mapped-account';

const PURCHASE_TENDER_KEY: Record<PurchasePaymentMethod, AccountingMappingKey> = {
  CASH: 'TENDER_CASH',
  BANK_TRANSFER: 'TENDER_BANK_TRANSFER',
  CHEQUE: 'TENDER_CHEQUE',
  CARD: 'TENDER_CARD',
  OTHER: 'TENDER_OTHER',
};

/**
 * Goods received against a Purchase: Dr Inventory, Cr Accounts Payable -
 * `totalReceivedValue` is the EXACT SAME figure ReceivePurchaseUseCase
 * already posts as SupplierTransaction(PURCHASE, +totalReceivedValue)
 * (SUM(quantityReceived x unitCost) across the receipt's lines, from
 * PurchaseItem.unitCost - never taxAmount/discountAmount, matching
 * Purchasing's own existing ledger exactly, not a "more correct" figure
 * derived from Purchase.totalAmount - see PROJECT_STATE.md for why this
 * is a deliberate consistency choice, not an oversight).
 */
export async function buildPurchaseReceiptJournalLines(tx: TenantTx, businessId: string, totalReceivedValue: Prisma.Decimal): Promise<PostEntryLineInput[]> {
  if (!totalReceivedValue.greaterThan(0)) return [];
  const accounts = await resolveMappedAccounts(tx, businessId, ['INVENTORY_ASSET', 'ACCOUNTS_PAYABLE']);
  return [
    { accountId: accounts.get('INVENTORY_ASSET')!, debit: totalReceivedValue, description: 'Goods received' },
    { accountId: accounts.get('ACCOUNTS_PAYABLE')!, credit: totalReceivedValue, description: 'Amount owed to supplier' },
  ];
}

/** A purchase return: Dr Accounts Payable, Cr Inventory - `totalCredit`
 * is the same figure already posted as
 * SupplierTransaction(PURCHASE_RETURN, -totalCredit). */
export async function buildPurchaseReturnJournalLines(tx: TenantTx, businessId: string, totalCredit: Prisma.Decimal): Promise<PostEntryLineInput[]> {
  if (!totalCredit.greaterThan(0)) return [];
  const accounts = await resolveMappedAccounts(tx, businessId, ['ACCOUNTS_PAYABLE', 'INVENTORY_ASSET']);
  return [
    { accountId: accounts.get('ACCOUNTS_PAYABLE')!, debit: totalCredit, description: 'Reduce amount owed to supplier' },
    { accountId: accounts.get('INVENTORY_ASSET')!, credit: totalCredit, description: 'Goods returned to supplier' },
  ];
}

/** A payment made to a supplier: Dr Accounts Payable, Cr the tender
 * account - mirrors PurchasePayment/SupplierTransaction(PAYMENT). */
export async function buildPurchasePaymentJournalLines(tx: TenantTx, businessId: string, amount: Prisma.Decimal, method: PurchasePaymentMethod): Promise<PostEntryLineInput[]> {
  if (!amount.greaterThan(0)) return [];
  const accounts = await resolveMappedAccounts(tx, businessId, ['ACCOUNTS_PAYABLE', PURCHASE_TENDER_KEY[method]]);
  return [
    { accountId: accounts.get('ACCOUNTS_PAYABLE')!, debit: amount, description: 'Payment to supplier' },
    { accountId: accounts.get(PURCHASE_TENDER_KEY[method])!, credit: amount, description: `Tender: ${method}` },
  ];
}
