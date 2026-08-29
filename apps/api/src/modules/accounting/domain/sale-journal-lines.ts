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

export interface SaleJournalInput {
  subtotal: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  totalCost: Prisma.Decimal;
  payments: { amount: Prisma.Decimal.Value; method: SalePaymentMethod }[];
}

/**
 * Two independently-balanced sub-groups combined into one entry:
 *   (a) what was tendered/owed  =  net revenue + tax
 *   (b) COGS  =  Inventory reduction
 * Every amount comes from values CreateSaleUseCase already computed
 * (subtotal/discountAmount/taxAmount/totalAmount from its own monetary
 * model, totalCost from computeSaleCost reading the SALE/
 * BUNDLE_CONSUMPTION StockMovement rows consumeVariant already wrote) -
 * nothing here recomputes a business fact. A zero-value line (no tax, no
 * cost, a fully-discounted item) is omitted rather than posted as a
 * meaningless 0 debit/credit - by construction its "partner" line on the
 * other side of the equation is mathematically zero too (payments +
 * remaining === totalAmount === netRevenue + tax; cost === cost), so
 * omitting matched zero pairs never unbalances the entry - see
 * PROJECT_STATE.md for the worked proof. If literally nothing has
 * financial substance (a 100%-discounted, zero-cost giveaway), this
 * returns an empty array and the caller does not post anything at all.
 */
export async function buildSaleJournalLines(tx: TenantTx, businessId: string, input: SaleJournalInput): Promise<PostEntryLineInput[]> {
  const paidNow = input.payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
  const remaining = input.totalAmount.minus(paidNow);
  const netRevenue = input.subtotal.minus(input.discountAmount);

  const neededKeys: AccountingMappingKey[] = [];
  if (netRevenue.greaterThan(0)) neededKeys.push('SALES_REVENUE');
  if (input.taxAmount.greaterThan(0)) neededKeys.push('TAX_PAYABLE');
  if (remaining.greaterThan(0)) neededKeys.push('ACCOUNTS_RECEIVABLE');
  if (input.totalCost.greaterThan(0)) neededKeys.push('COGS', 'INVENTORY_ASSET');
  for (const p of input.payments) {
    if (new Prisma.Decimal(p.amount).greaterThan(0)) neededKeys.push(SALE_TENDER_KEY[p.method]);
  }

  const accounts = await resolveMappedAccounts(tx, businessId, neededKeys);
  const lines: PostEntryLineInput[] = [];

  for (const p of input.payments) {
    const amount = new Prisma.Decimal(p.amount);
    if (amount.greaterThan(0)) {
      lines.push({ accountId: accounts.get(SALE_TENDER_KEY[p.method])!, debit: amount, description: `Tender: ${p.method}` });
    }
  }
  if (remaining.greaterThan(0)) {
    lines.push({ accountId: accounts.get('ACCOUNTS_RECEIVABLE')!, debit: remaining, description: 'Amount owed by customer' });
  }
  if (netRevenue.greaterThan(0)) {
    lines.push({ accountId: accounts.get('SALES_REVENUE')!, credit: netRevenue, description: 'Sales revenue' });
  }
  if (input.taxAmount.greaterThan(0)) {
    lines.push({ accountId: accounts.get('TAX_PAYABLE')!, credit: input.taxAmount, description: 'Sales tax' });
  }
  if (input.totalCost.greaterThan(0)) {
    lines.push({ accountId: accounts.get('COGS')!, debit: input.totalCost, description: 'Cost of goods sold' });
    lines.push({ accountId: accounts.get('INVENTORY_ASSET')!, credit: input.totalCost, description: 'Inventory reduction' });
  }

  return lines;
}
