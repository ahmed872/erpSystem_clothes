import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PreviewSaleReturnInput } from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { round4 } from '../../../../common/domain/money';
import { TaxEngineService } from '../../../../engines/tax/tax-engine.service';
import { lineReturnCredit } from '../../domain/return-credit';

/**
 * Phase 12 (Returns) — WHAT THIS RETURN IS WORTH, BEFORE IT HAPPENS.
 *
 * `CreateSaleReturnUseCase` requires a WALK-IN refund to equal the return
 * credit exactly - `!refundAmount.equals(totalRefundable)` is refused - and
 * that credit is BD-1's cumulative merchandise apportionment plus BD-18's
 * cumulative tax reversal. Neither is derivable by a client without
 * re-implementing both rules in the browser, which every decision since
 * Phase 6 forbids. So the till was asking a cashier to type a figure the
 * system had never shown them. This answers it.
 *
 * IT IS NOT A SECOND RETURN ENGINE, and could not become one by accident.
 * The two figures come from the SAME functions the write path calls, on
 * the same inputs:
 *
 *   - `lineReturnCredit(saleItem, quantity)` — the single shared BD-1
 *     definition in `domain/return-credit.ts`, used by the refund, the
 *     loyalty clawback and the redemption restoration alike.
 *   - `TaxEngineService.cumulativeLineTax(...)` — BD-18's cumulative
 *     reversal, the same call `executeInTx` makes.
 *
 * Both are PURE functions of values already stored on the sale line
 * (quantity, unitPrice, discountAmount, quantityReturned, taxAmount).
 * They sit inside the write loop in `executeInTx` for a single pass, not
 * because they depend on anything written there - which is precisely why
 * this preview needs no extraction from that 684-line use-case and no
 * restructuring of it.
 *
 * WHAT IS DELIBERATELY NOT PREVIEWED. The loyalty clawback, the redemption
 * restoration, the inventory movements and the journal entry are all
 * consequences of the return, not figures a cashier needs before handing
 * money back. Computing them here would mean reaching into code that DOES
 * interleave with writes, for no operational benefit.
 *
 * SIDE-EFFECT FREEDOM IS ENFORCED BY POSTGRESQL. The whole thing runs in
 * `withTenantReadOnly`, so any INSERT, UPDATE, DELETE or
 * `SELECT ... FOR UPDATE` reaching it fails with SQLSTATE 25006 - today,
 * and after any future edit. No SaleReturn, no stock movement, no journal
 * entry, no loyalty row, no serial transition, no refund.
 *
 * A PREVIEW IS NOT A HOLD. Nothing is locked and nothing is reserved. The
 * real return re-validates everything under `lockCustomer` and `lockSale`
 * and remains the only authority; a preview whose sale has moved on simply
 * produces a return that is refused or priced differently.
 *
 * `computeInTx` vs `execute` (Phase 12, Exchange preview). The body is
 * `computeInTx`, which takes an ALREADY-OPEN transaction rather than
 * opening one itself. `execute` is the thin HTTP-facing wrapper that opens
 * `withTenantReadOnly` and calls it - unchanged behaviour, same route,
 * same tests. The split exists so `PreviewExchangeUseCase` can run this
 * SAME computation for the return half of an exchange preview, inside its
 * OWN read-only transaction, instead of re-implementing return eligibility
 * and BD-1/BD-18 a second time. Nothing here was reinterpreted to make
 * that possible - only where the transaction is opened moved.
 */
@Injectable()
export class PreviewSaleReturnUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tax: TaxEngineService,
  ) {}

  async execute(actor: RequestUser, saleId: string, input: PreviewSaleReturnInput) {
    return this.prisma.withTenantReadOnly(actor.tenantId, (tx) => this.computeInTx(tx, actor, saleId, input));
  }

  async computeInTx(tx: TenantTx, actor: RequestUser, saleId: string, input: PreviewSaleReturnInput) {
    const sale = await tx.sale.findFirst({
      where: { id: saleId, businessId: actor.tenantId },
      include: {
        customer: { select: { id: true, name: true, isActive: true } },
        items: {
          include: {
            variant: {
              select: {
                id: true,
                sku: true,
                product: { select: { id: true, name: true, alternativeName: true, type: true, tracksSerialNumbers: true } },
              },
            },
            SaleItemSerial: { include: { serialNumber: { select: { serial: true } } } },
          },
        },
      },
    });
    if (!sale) throw new NotFoundDomainError('Sale', saleId);

    const itemIds = input.items.map((i) => i.saleItemId);
    if (new Set(itemIds).size !== itemIds.length) {
      throw new ValidationFailedError('Duplicate saleItemId in return request');
    }
    const itemsById = new Map(sale.items.map((i) => [i.id, i]));

    // The SAME eligibility checks the write path runs, in the same
    // order, with the same messages - so a preview that succeeds is a
    // return that will not be refused for any of these reasons, and a
    // preview that fails explains it before a queue forms.
    let totalCredit = new Prisma.Decimal(0);
    let totalTaxReversal = new Prisma.Decimal(0);

    const lines = input.items.map((line) => {
      const saleItem = itemsById.get(line.saleItemId);
      if (!saleItem) throw new NotFoundDomainError('SaleItem', line.saleItemId);
      if (saleItem.variant.product.type === 'BUNDLE') {
        throw new ValidationFailedError('Bundle sale items cannot be returned - return the individual components instead', {
          saleItemId: saleItem.id,
        });
      }

      const tracksSerials = saleItem.variant.product.tracksSerialNumbers;
      const supplied = line.serials ?? [];
      if (tracksSerials && supplied.length === 0) {
        throw new ValidationFailedError(
          'This product is serial-tracked - the serial number(s) being returned must be supplied for this line',
          { saleItemId: saleItem.id },
        );
      }
      if (!tracksSerials && supplied.length > 0) {
        throw new ValidationFailedError('This product is not serial-tracked - serial numbers cannot be supplied for this line', {
          saleItemId: saleItem.id,
        });
      }
      if (tracksSerials && !new Prisma.Decimal(line.quantity).equals(supplied.length)) {
        throw new ValidationFailedError('The number of serials supplied must equal the quantity being returned for this line', {
          saleItemId: saleItem.id,
          quantity: new Prisma.Decimal(line.quantity).toString(),
          serialsSupplied: supplied.length,
        });
      }

      const available = saleItem.quantity.minus(saleItem.quantityReturned);
      if (new Prisma.Decimal(line.quantity).greaterThan(available)) {
        throw new ConflictDomainError(
          `Cannot return ${line.quantity} of variant ${saleItem.variantId} - only ${available.toString()} is available to return`,
          { saleItemId: saleItem.id, available: available.toString(), requested: line.quantity },
        );
      }

      // BD-1, via the one shared definition. Not re-derived here.
      const credit = lineReturnCredit(saleItem, line.quantity);
      // BD-18's cumulative reversal, as a delta - exactly as the write
      // path computes it, so three partial returns reverse precisely the
      // tax that was charged.
      const taxBefore = this.tax.cumulativeLineTax(saleItem.taxAmount, saleItem.quantity, saleItem.quantityReturned);
      const taxAfter = this.tax.cumulativeLineTax(
        saleItem.taxAmount,
        saleItem.quantity,
        saleItem.quantityReturned.plus(line.quantity),
      );
      const taxReversal = taxAfter.minus(taxBefore);

      totalCredit = totalCredit.plus(credit);
      totalTaxReversal = totalTaxReversal.plus(taxReversal);

      return {
        saleItemId: saleItem.id,
        variantId: saleItem.variantId,
        sku: saleItem.variant.sku,
        name: saleItem.variant.product.name,
        alternativeName: saleItem.variant.product.alternativeName,
        quantity: new Prisma.Decimal(line.quantity).toString(),
        quantitySold: saleItem.quantity.toString(),
        quantityAlreadyReturned: saleItem.quantityReturned.toString(),
        quantityAvailableToReturn: available.toString(),
        condition: line.condition,
        requiresSerials: tracksSerials,
        serials: supplied,
        merchandiseCredit: round4(credit).toString(),
        taxReversal: round4(taxReversal).toString(),
        lineRefundable: round4(credit.plus(taxReversal)).toString(),
      };
    });

    const totalRefundable = round4(totalCredit.plus(totalTaxReversal));

    // BD-23, restated as the caller needs it rather than as a rule to
    // re-derive. A walk-in has no ledger for a partial credit to sit on,
    // so the refund must be the whole figure; an account customer may
    // take less and leave the remainder on their account.
    const isWalkIn = !sale.customerId;
    const refundRequired = isWalkIn && totalRefundable.greaterThan(0);

    return {
      sale: {
        id: sale.id,
        saleNumber: sale.saleNumber,
        createdAt: sale.createdAt,
        shiftId: sale.shiftId,
        totalAmount: sale.totalAmount.toString(),
      },
      customer: sale.customer,
      isWalkIn,
      lines,
      totals: {
        merchandiseCredit: round4(totalCredit).toString(),
        taxReversal: round4(totalTaxReversal).toString(),
        /** BD-1 + BD-18. The figure every rule below is stated against. */
        totalRefundable: totalRefundable.toString(),
      },
      refund: {
        /** A walk-in must be handed the whole credit. */
        required: refundRequired,
        /** Exactly what to send as `refund.amount`, or null when free. */
        requiredAmount: refundRequired ? totalRefundable.toString() : null,
        /** Nobody may be refunded more than the credit, ever. */
        maxAmount: totalRefundable.toString(),
        /** What an account customer leaves on their ledger if they take nothing. */
        creditToLedgerIfNoRefund: isWalkIn ? '0' : totalRefundable.toString(),
      },
      previewedAt: new Date().toISOString(),
      guarantees: {
        authoritativeCredit: true,
        reservesNothing: true,
        createsNothing: true,
        /** The return re-validates stock, serials, locks and eligibility. */
        finalReturnRevalidates: true,
      },
    };
  }
}
