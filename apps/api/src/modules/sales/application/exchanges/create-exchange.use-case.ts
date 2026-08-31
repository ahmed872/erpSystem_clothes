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
 * DELIBERATE BOUNDARY: A DOWNWARD EXCHANGE IS REFUSED. Swapping for
 * something CHEAPER is a return plus a separate sale — the difference is
 * real money going back to the customer, and the return document already
 * models that event exactly, with its own refund tender. Expressing it
 * here would need a two-part refund (part clearing, part cash) that the
 * append-only `sale_returns` row cannot carry, and inventing that shape
 * now would be widening the scope rather than implementing it. The
 * rejection, raised by CreateSaleUseCase, names both figures and says
 * what to do instead.
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
        { returnId: saleReturn.id, credit: new Prisma.Decimal(saleReturn.totalRefundable) },
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

      return {
        saleReturn,
        sale: replacement,
        // What the two halves settled between them, and what the customer
        // still had to tender on top. Surfaced because a receipt has to
        // show both, and deriving them client-side from two documents is
        // exactly the kind of arithmetic that drifts.
        exchangeCredit: credit.toString(),
        amountDue: new Prisma.Decimal(replacement.totalAmount).minus(credit).toString(),
      };
    });
  }
}
