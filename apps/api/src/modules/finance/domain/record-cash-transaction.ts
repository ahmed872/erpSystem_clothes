import { CashTransactionType, Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { round4 } from '../../../common/domain/money';

/**
 * Phase 10 (BD-17) — the single writer for the drawer ledger.
 *
 * Every movement of physical cash goes through here: sale tenders, refunds,
 * manual pay-ins and pay-outs, and cash expenses. Callers pass the POSITIVE
 * magnitude and the type; this function applies the sign. That keeps the
 * sign convention in exactly one place rather than at every call site, and
 * a database CHECK (`cash_transactions_amount_sign_matches_type`) rejects
 * any row that disagrees, so a mis-signed insert is impossible rather than
 * merely unlikely.
 *
 * Deliberately a domain function rather than a use-case: it always runs
 * INSIDE the caller's transaction, so the drawer movement and the document
 * that caused it commit together or not at all. A sale can never record a
 * tender without the cash row, and the cash row can never survive a sale
 * that rolled back.
 *
 * Non-cash tenders (card, wallet, bank transfer, cheque) must NOT be passed
 * here. They post to their own clearing accounts through the
 * AccountingEngine and never enter the physical drawer, so including them
 * would make expected cash wrong by exactly the card takings.
 */

const NEGATIVE_TYPES: ReadonlySet<CashTransactionType> = new Set<CashTransactionType>([
  'SALE_REFUND',
  'PAY_OUT',
  'EXPENSE',
]);

export interface RecordCashTransactionParams {
  businessId: string;
  shiftId: string;
  type: CashTransactionType;
  /** Positive magnitude. The sign is applied here from `type`. */
  amount: Prisma.Decimal.Value;
  referenceType?: string;
  referenceId?: string;
  reason?: string;
  createdBy?: string | null;
}

export async function recordCashTransaction(tx: TenantTx, params: RecordCashTransactionParams) {
  const magnitude = round4(new Prisma.Decimal(params.amount).abs());

  // A zero movement is not a movement. Silently skipping it (rather than
  // letting the CHECK reject it) keeps callers simple: a sale with no cash
  // tender, or a fully-account-settled return, just writes nothing.
  if (magnitude.isZero()) return null;

  const signed = NEGATIVE_TYPES.has(params.type) ? magnitude.negated() : magnitude;

  return tx.cashTransaction.create({
    data: {
      businessId: params.businessId,
      shiftId: params.shiftId,
      type: params.type,
      amount: signed,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      reason: params.reason,
      createdBy: params.createdBy ?? null,
    },
  });
}
