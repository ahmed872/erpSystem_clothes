import { AccountingMappingKey, Prisma, SalePaymentMethod } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { PostEntryLineInput } from '../../../engines/accounting/accounting-engine.service';
import { resolveMappedAccounts } from './resolve-mapped-account';
import { round4 } from '../../../common/domain/money';

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
  /**
   * Phase 10 (BD-23): the tender actually handed back, if any. NULL means
   * no money moved and the whole credit stays on the customer's ledger.
   */
  refund: { method: SalePaymentMethod; amount: Prisma.Decimal } | null;
  /**
   * Phase 10 (BD-18): the tax portion coming back, apportioned by BD-1's
   * cumulative method. Reverses out of Tax Payable, so the liability tracks
   * only the tax actually retained.
   */
  taxReversal: Prisma.Decimal;
  /**
   * Phase 10.2 (Exchanges) — the portion of the credit that settles a
   * replacement sale instead of going back as money or onto a ledger.
   *
   * Credited to EXCHANGE_CLEARING, which the replacement debits by the
   * same figure, so the pair nets to exactly zero. Kept as its own input
   * rather than dressed up as a tender because it is not one: no money
   * moves, and a downward exchange credits BOTH this account and a real
   * tender in the same entry - a shape a single `refund` cannot express.
   */
  exchangeCredit?: Prisma.Decimal;
}

const SALE_TENDER_KEY: Record<SalePaymentMethod, AccountingMappingKey> = {
  CASH: 'TENDER_CASH',
  CARD: 'TENDER_CARD',
  WALLET: 'TENDER_WALLET',
  OTHER: 'TENDER_OTHER',
  // Phase 10.2: unreachable on this side - a return's refund method comes
  // from a schema that admits only real tenders, and the exchange portion
  // now arrives as its own `exchangeCredit` input. Mapped correctly anyway,
  // because an exhaustive Record that lies about one case is worse than one
  // that carries a case nothing reaches.
  EXCHANGE_CREDIT: 'EXCHANGE_CLEARING',
};

/**
 * Up to three independent sub-groups: (a) Inventory in / COGS reversal for
 * the returned cost, (b) Inventory out / Shrinkage for the damaged portion,
 * (c) the revenue reversal and its credit side.
 *
 * PHASE 10 (BD-23) — KNOWN ISSUE #32 IS CLOSED HERE.
 *
 * Until Phase 10 a walk-in return posted only (a) and (b): Sales recorded
 * no refund event of any kind, so Accounting had no operational fact from
 * which to credit Cash or reverse Revenue, and inventing one was
 * forbidden. #32 stated the condition for any future fix precisely - it
 * "MUST be driven by a real operational business fact newly recorded at the
 * source... and must NOT be implemented by re-deriving, inferring, or
 * reconstructing the refund from the Sale/SaleReturn documents after the
 * fact." `SaleReturn.refundMethod/refundAmount` is exactly that fact, keyed
 * in by the person handing the money over, and it is what this function now
 * posts from. Nothing is inferred.
 *
 * The credit side splits between the two places the value can go:
 *
 *   refundAmount        -> the tender account (money left the business)
 *   totalCredit - refund -> Accounts Receivable (credit stays on the
 *                           customer's ledger)
 *
 * For a walk-in the refund necessarily equals the whole credit (there is no
 * ledger to hold a remainder - CreateSaleReturnUseCase enforces it), so the
 * AR line simply does not arise. For an account customer with no refund the
 * behaviour is byte-identical to Phase 6's, which is what keeps every
 * existing return test valid.
 */
export async function buildSaleReturnJournalLines(tx: TenantTx, businessId: string, input: SaleReturnJournalInput): Promise<PostEntryLineInput[]> {
  // Rounded to the monetary scale before being tested or posted - see
  // buildSaleJournalLines for why a sub-scale residual would otherwise
  // store as 0.0000 and violate the double-entry CHECK. `returnInCost`
  // in particular is `quantity x unitCostAtMovement`, two 4-dp values
  // whose product can carry 8 dp.
  const returnInCost = round4(input.returnInCost);
  const damageWriteOff = round4(input.damageWriteOff);
  const totalCredit = round4(input.totalCredit);

  const neededKeys: AccountingMappingKey[] = [];
  if (returnInCost.greaterThan(0)) neededKeys.push('INVENTORY_ASSET', 'COGS');
  if (damageWriteOff.greaterThan(0)) neededKeys.push('INVENTORY_SHRINKAGE');
  const taxReversal = round4(input.taxReversal);
  // What the customer gets back: merchandise plus the tax they paid on it.
  const totalRefundable = round4(totalCredit.plus(taxReversal));
  const refundAmount = input.refund ? round4(input.refund.amount) : new Prisma.Decimal(0);
  const exchangeCredit = input.exchangeCredit ? round4(input.exchangeCredit) : new Prisma.Decimal(0);
  // Every unit of the credit lands in exactly one of three places: spent
  // on a replacement, handed back as money, or left on the customer's
  // ledger. Nothing is unaccounted for, which is what makes the entry
  // balance without a plug.
  const ledgerCredit = round4(totalRefundable.minus(refundAmount).minus(exchangeCredit));

  // Revenue now reverses whenever the value went SOMEWHERE real - either
  // onto a customer's ledger or back out as a tender. A walk-in return with
  // a recorded refund therefore reverses revenue for the first time.
  const postRevenueReversal =
    totalRefundable.greaterThan(0) && (Boolean(input.customerId) || refundAmount.greaterThan(0) || exchangeCredit.greaterThan(0));
  if (postRevenueReversal) {
    neededKeys.push('SALES_REVENUE');
    if (taxReversal.greaterThan(0)) neededKeys.push('TAX_PAYABLE');
    if (refundAmount.greaterThan(0)) neededKeys.push(SALE_TENDER_KEY[input.refund!.method]);
    if (exchangeCredit.greaterThan(0)) neededKeys.push('EXCHANGE_CLEARING');
    if (ledgerCredit.greaterThan(0)) neededKeys.push('ACCOUNTS_RECEIVABLE');
  }

  const accounts = await resolveMappedAccounts(tx, businessId, neededKeys);
  const lines: PostEntryLineInput[] = [];

  if (returnInCost.greaterThan(0)) {
    lines.push({ accountId: accounts.get('INVENTORY_ASSET')!, debit: returnInCost, description: 'Returned goods back into inventory' });
    lines.push({ accountId: accounts.get('COGS')!, credit: returnInCost, description: 'Reverse cost of goods sold' });
  }
  if (damageWriteOff.greaterThan(0)) {
    lines.push({ accountId: accounts.get('INVENTORY_SHRINKAGE')!, debit: damageWriteOff, description: 'Returned goods written off as damaged' });
    lines.push({ accountId: accounts.get('INVENTORY_ASSET')!, credit: damageWriteOff, description: 'Damaged return write-off' });
  }
  if (postRevenueReversal) {
    lines.push({ accountId: accounts.get('SALES_REVENUE')!, debit: totalCredit, description: 'Reverse sales revenue' });
    if (taxReversal.greaterThan(0)) {
      lines.push({ accountId: accounts.get('TAX_PAYABLE')!, debit: taxReversal, description: 'Reverse tax charged on returned goods' });
    }
    if (refundAmount.greaterThan(0)) {
      lines.push({
        accountId: accounts.get(SALE_TENDER_KEY[input.refund!.method])!,
        credit: refundAmount,
        description: `Refund tendered: ${input.refund!.method}`,
      });
    }
    if (exchangeCredit.greaterThan(0)) {
      lines.push({
        accountId: accounts.get('EXCHANGE_CLEARING')!,
        credit: exchangeCredit,
        description: 'Credit applied to the replacement sale',
      });
    }
    if (ledgerCredit.greaterThan(0)) {
      lines.push({ accountId: accounts.get('ACCOUNTS_RECEIVABLE')!, credit: ledgerCredit, description: 'Customer credit for return' });
    }
  }

  return lines;
}
