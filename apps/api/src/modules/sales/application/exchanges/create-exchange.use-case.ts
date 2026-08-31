import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreateExchangeInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { CreateSaleReturnUseCase } from '../returns/create-sale-return.use-case';
import { CreateSaleUseCase } from '../sales/create-sale.use-case';

/**
 * Phase 10 (Exchanges) — goods back and goods out, as ONE event.
 *
 * THE ONLY THING THIS USE-CASE ADDS is atomicity and the arithmetic that
 * joins the two halves. It composes the SAME return and the SAME sale the
 * existing endpoints create, through their `executeInTx` methods, inside
 * one transaction. It re-implements nothing: BD-1 still decides the
 * credit, BD-18 still decides the tax, BD-13 still demands serials, and
 * `InventoryEngine` and `AccountingEngine` remain the only things that
 * move stock or post entries.
 *
 * WHY ONE TRANSACTION. An exchange that half-succeeded — the goods back
 * on the shelf, the replacement never issued, the customer already out of
 * the door — is a failure no reconciliation could untangle afterwards.
 * That is what the composition exists to prevent, and it is why both
 * use-cases were split into caller-owned-transaction methods rather than
 * being called over HTTP one after the other.
 *
 * HOW THE MONEY MEETS IN THE MIDDLE. The return's entire credit goes to
 * the EXCHANGE_CLEARING account instead of a tender or a ledger; the
 * replacement sale debits the same account by the same figure as an
 * EXCHANGE_CREDIT payment. A completed exchange therefore leaves that
 * account at exactly zero, which is what makes a non-zero balance on it a
 * real signal rather than ordinary noise.
 *
 * REPLAY. An exchange carries ONE idempotency key, derived into one per
 * half (`:return` and `:sale`). Both halves therefore run their OWN
 * fingerprint comparison on a replay, so a key reused with different goods
 * on EITHER side is rejected rather than silently handed the first
 * exchange's documents - and a replay creates neither document twice.
 *
 * ORDER. The return runs FIRST, because its credit is what the
 * replacement is settled with and there is no way to know it beforehand.
 * Both halves take locks in the canonical order (Customer -> Sale ->
 * StockBalance -> SerialNumber), and the second half re-taking a lock the
 * first already holds is free, so composing them cannot deadlock where
 * either alone would not.
 *
 * ALL THREE DIRECTIONS ARE ONE PATH (Phase 10.2). Upward, even and
 * downward exchanges differ only in the value of two figures, never in the
 * code that runs:
 *
 *     requiredRefund = max(0, returnCredit - replacementTotal)
 *     creditApplied  = returnCredit - requiredRefund
 *
 * Upward and even exchanges require a refund of zero and the customer
 * tenders any difference; a downward one refunds precisely the surplus and
 * the customer tenders nothing. The two settlement identities that follow
 * are what keep the money honest, and both are enforced:
 *
 *     returnCredit    = creditApplied + refund      (the return half)
 *     replacementTotal = creditApplied + tender     (the sale half)
 *
 * so `returnCredit + tender = replacementTotal + refund` — money in equals
 * money out, with nothing left over to go missing.
 *
 * THE REFUND AMOUNT IS NOT TRUSTED. The client names the METHOD, because
 * only the till knows whether the difference went back as cash or to a
 * card. The AMOUNT is proved against the two totals by
 * `CreateSaleUseCase`, the only place that knows the replacement's, and a
 * wrong figure rolls the whole exchange back naming the one that would
 * have worked.
 */
@Injectable()
export class CreateExchangeUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly returns: CreateSaleReturnUseCase,
    private readonly sales: CreateSaleUseCase,
  ) {}

  async execute(actor: RequestUser, saleId: string, input: CreateExchangeInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const original = await tx.sale.findFirst({
        where: { id: saleId, businessId: actor.tenantId },
        select: { id: true, warehouseId: true, customerId: true },
      });
      if (!original) throw new NotFoundDomainError('Sale', saleId);

      // ---------------------------------------------------------------
      // HALF ONE: the goods coming back.
      //
      // `settledByExchange` is set HERE, by the server, and cannot be
      // reached from a request. It sends the whole credit to the clearing
      // account rather than to a tender or the customer's ledger.
      // ---------------------------------------------------------------
      const saleReturn = await this.returns.executeInTx(
        tx,
        actor,
        saleId,
        {
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:return` : undefined,
          reason: input.reason,
          items: input.returnItems,
          // Phase 10.2: the money going back, when the replacement is worth
          // less than the goods returned. Recorded on the return itself -
          // it is a real tender handed to the customer, which is exactly
          // what `SaleReturn.refundMethod`/`refundAmount` mean - and its
          // amount is proved by the replacement below before this
          // transaction can commit.
          refund: input.refund,
        },
        true,
      );

      // ---------------------------------------------------------------
      // HALF TWO: the goods going out.
      //
      // The warehouse and the customer come from the ORIGINAL sale, never
      // from the request: an exchange is against that sale, and letting a
      // client name a different warehouse or customer would move goods and
      // credit between places the original document never mentioned.
      // ---------------------------------------------------------------
      const replacement = await this.sales.executeInTx(
        tx,
        actor,
        {
          warehouseId: original.warehouseId,
          customerId: original.customerId ?? undefined,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:sale` : undefined,
          items: input.newItems,
          payments: input.payments,
          redeemPoints: input.redeemPoints,
        },
        {
          returnId: saleReturn.id,
          returnCredit: new Prisma.Decimal(saleReturn.totalRefundable),
          refundAmount: new Prisma.Decimal(input.refund?.amount ?? 0),
        },
      );

      // The credit is read back from the replacement's own
      // EXCHANGE_CREDIT payment row rather than from the figure computed a
      // moment ago. That row is where the fact actually lives, so this is
      // the one reading that is equally right on a first run and on an
      // idempotent replay - where recomputing it would mean recomputing
      // history (non-negotiable #8).
      const credit = replacement.payments
        .filter((p) => p.method === 'EXCHANGE_CREDIT')
        .reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));

      // Likewise the refund: read from the return row that stores it, not
      // from the request that asked for it.
      const refunded = saleReturn.refundAmount ?? new Prisma.Decimal(0);

      return {
        saleReturn,
        sale: replacement,
        // The three figures a receipt has to show: what the returned goods
        // paid for, what the customer still had to tender, and what went
        // back to them as money. Exactly one of the last two can be
        // non-zero. Deriving them client-side from two documents is
        // precisely the kind of arithmetic that drifts.
        exchangeCredit: credit.toString(),
        amountDue: new Prisma.Decimal(replacement.totalAmount).minus(credit).toString(),
        refunded: refunded.toString(),
      };
    });
  }
}
