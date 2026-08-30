import { AccountingMappingKey, Prisma, SalePaymentMethod } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { PostEntryLineInput } from '../../../engines/accounting/accounting-engine.service';
import { resolveMappedAccounts } from './resolve-mapped-account';
import { round4 } from '../../../common/domain/money';

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
  // Every amount is rounded to the MONETARY SCALE before it is tested or
  // posted, because that is the scale `journal_entry_lines.debit/credit`
  // actually store. Without this a residual smaller than half a
  // ten-thousandth - a client tendering a float-computed total, say -
  // passes `greaterThan(0)` at full precision but is stored as 0.0000,
  // violating `journal_entry_lines_debit_xor_credit` and failing the
  // whole sale with a 500. (Found during Phase 8C testing; verified
  // present on the pre-8C code as well, so it is a latent defect being
  // fixed, not a regression being papered over.)
  //
  // `remaining` is derived from the ROUNDED tenders, not the raw ones, so
  // `SUM(tenders) + remaining === totalAmount` still holds exactly at the
  // stored scale and the entry stays balanced by construction.
  const roundedPayments = input.payments.map((p) => ({ method: p.method, amount: round4(p.amount) }));
  const paidNow = roundedPayments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
  const totalAmount = round4(input.totalAmount);
  const remaining = totalAmount.minus(paidNow);
  const netRevenue = round4(input.subtotal.minus(input.discountAmount));
  const taxAmount = round4(input.taxAmount);
  const totalCost = round4(input.totalCost);

  const neededKeys: AccountingMappingKey[] = [];
  if (netRevenue.greaterThan(0)) neededKeys.push('SALES_REVENUE');
  if (taxAmount.greaterThan(0)) neededKeys.push('TAX_PAYABLE');
  if (remaining.greaterThan(0)) neededKeys.push('ACCOUNTS_RECEIVABLE');
  if (totalCost.greaterThan(0)) neededKeys.push('COGS', 'INVENTORY_ASSET');
  for (const p of roundedPayments) {
    if (p.amount.greaterThan(0)) neededKeys.push(SALE_TENDER_KEY[p.method]);
  }

  const accounts = await resolveMappedAccounts(tx, businessId, neededKeys);
  const lines: PostEntryLineInput[] = [];

  for (const p of roundedPayments) {
    if (p.amount.greaterThan(0)) {
      lines.push({ accountId: accounts.get(SALE_TENDER_KEY[p.method])!, debit: p.amount, description: `Tender: ${p.method}` });
    }
  }
  if (remaining.greaterThan(0)) {
    lines.push({ accountId: accounts.get('ACCOUNTS_RECEIVABLE')!, debit: remaining, description: 'Amount owed by customer' });
  }
  if (netRevenue.greaterThan(0)) {
    lines.push({ accountId: accounts.get('SALES_REVENUE')!, credit: netRevenue, description: 'Sales revenue' });
  }
  if (taxAmount.greaterThan(0)) {
    lines.push({ accountId: accounts.get('TAX_PAYABLE')!, credit: taxAmount, description: 'Sales tax' });
  }
  if (totalCost.greaterThan(0)) {
    lines.push({ accountId: accounts.get('COGS')!, debit: totalCost, description: 'Cost of goods sold' });
    lines.push({ accountId: accounts.get('INVENTORY_ASSET')!, credit: totalCost, description: 'Inventory reduction' });
  }

  return lines;
}
