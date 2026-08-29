import { AccountingMappingKey, Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { PostEntryLineInput } from '../../../engines/accounting/accounting-engine.service';
import { resolveMappedAccounts } from './resolve-mapped-account';

export interface SaleReturnJournalInput {
  customerId: string | null;
  /** SUM(quantity x unitPrice) across every returned line, regardless of
   * condition - the same figure CreateSaleReturnUseCase already posts as
   * CustomerTransaction(SALE_RETURN, -totalCredit). */
  totalCredit: Prisma.Decimal;
  /** SUM(quantity x ORIGINAL sale's unit_cost_at_movement) across every
   * returned line (both SELLABLE and DAMAGED - the SALES_RETURN increase
   * is posted for both), carried over exactly, never re-derived. */
  returnInCost: Prisma.Decimal;
  /** SUM(quantity x the DAMAGE movement's OWN unit_cost_at_movement, i.e.
   * the current average cost at the moment of write-off) across DAMAGED
   * lines only. Deliberately NOT assumed equal to returnInCost's
   * damaged-line portion - the DAMAGE decrease costs out at today's
   * average per the standard decrease-costing rule (Phase 3), which can
   * genuinely differ from what the SAME units were valued at on the
   * original sale if the average drifted in between. The resulting small
   * residual on the Inventory account is a real, correct consequence of
   * WAC costing, not a bug - see PROJECT_STATE.md.
   */
  damageWriteOff: Prisma.Decimal;
}

/**
 * Up to three independent sub-groups: (a) Inventory in / COGS reversal
 * for the returned cost, (b) Inventory out / Shrinkage for the damaged
 * portion, (c) Revenue reversal / AR credit for a customer-attached
 * return only. Walk-in (customerId=null) returns deliberately do NOT
 * post (c) - CreateSaleReturnUseCase itself posts no CustomerTransaction
 * for a walk-in return (there is no customer ledger to credit), and
 * Sales' Phase 5 design records no cash-refund event for a walk-in
 * return either - Accounting has no operational fact to post a Cash
 * credit from without inventing one, so it deliberately does not. This
 * is a documented, known limitation (see PROJECT_STATE.md Known Issues),
 * not a silent gap: a walk-in return corrects Inventory/COGS accurately
 * but does NOT reduce Sales Revenue in the GL.
 */
export async function buildSaleReturnJournalLines(tx: TenantTx, businessId: string, input: SaleReturnJournalInput): Promise<PostEntryLineInput[]> {
  const neededKeys: AccountingMappingKey[] = [];
  if (input.returnInCost.greaterThan(0)) neededKeys.push('INVENTORY_ASSET', 'COGS');
  if (input.damageWriteOff.greaterThan(0)) neededKeys.push('INVENTORY_SHRINKAGE');
  const postRevenueReversal = Boolean(input.customerId) && input.totalCredit.greaterThan(0);
  if (postRevenueReversal) neededKeys.push('SALES_REVENUE', 'ACCOUNTS_RECEIVABLE');

  const accounts = await resolveMappedAccounts(tx, businessId, neededKeys);
  const lines: PostEntryLineInput[] = [];

  if (input.returnInCost.greaterThan(0)) {
    lines.push({ accountId: accounts.get('INVENTORY_ASSET')!, debit: input.returnInCost, description: 'Returned goods back into inventory' });
    lines.push({ accountId: accounts.get('COGS')!, credit: input.returnInCost, description: 'Reverse cost of goods sold' });
  }
  if (input.damageWriteOff.greaterThan(0)) {
    lines.push({ accountId: accounts.get('INVENTORY_SHRINKAGE')!, debit: input.damageWriteOff, description: 'Returned goods written off as damaged' });
    lines.push({ accountId: accounts.get('INVENTORY_ASSET')!, credit: input.damageWriteOff, description: 'Damaged return write-off' });
  }
  if (postRevenueReversal) {
    lines.push({ accountId: accounts.get('SALES_REVENUE')!, debit: input.totalCredit, description: 'Reverse sales revenue' });
    lines.push({ accountId: accounts.get('ACCOUNTS_RECEIVABLE')!, credit: input.totalCredit, description: 'Customer credit for return' });
  }

  return lines;
}
