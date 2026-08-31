import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { computePaymentSummary } from '../../domain/payment-summary';

/**
 * Phase 10 (10F) — everything a printed receipt needs, in one request.
 *
 * WHY THIS EXISTS AS AN ENDPOINT rather than being assembled client-side.
 * A receipt is a legal-ish artefact: the figures on it must be the ones in
 * the books. Assembling it from four or five separate calls means a client
 * re-deriving totals, tax and change from parts - and every client would
 * re-derive them slightly differently, in a different order, with a
 * different rounding. The server already knows all of it exactly, so it
 * hands the whole thing over and nothing has to be recomputed.
 *
 * NOTHING HERE IS CALCULATED FRESH. Every money figure is read from what
 * the sale STORED: the line's own `taxAmount` and `taxRateSnapshot`, the
 * sale's `totalAmount`, the payment rows. Reprinting a receipt from six
 * months ago therefore shows the same numbers it showed then, even if the
 * tax rate, the price list and the promotion have all changed since -
 * which is non-negotiable #8 applied to the one artefact a customer keeps.
 *
 * COST AND PROFIT ARE NOT IN THE PAYLOAD AT ALL, for anybody. Unlike
 * `GetSaleUseCase`, which reveals them to a holder of `products.view_cost`,
 * a receipt is a document handed to a CUSTOMER. Even an owner printing one
 * must not have the shop's margin on it.
 */
@Injectable()
export class GetSaleReceiptUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, saleId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, businessId: actor.tenantId },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          branch: { select: { id: true, name: true, address: true, phone: true } },
          shift: { select: { id: true, cashRegisterId: true, openedBy: true } },
          items: {
            include: {
              variant: { select: { id: true, sku: true, product: { select: { name: true, alternativeName: true } } } },
              SaleItemSerial: { include: { serialNumber: { select: { serial: true } } } },
            },
          },
          payments: { orderBy: { receivedAt: 'asc' } },
          returns: { select: { id: true, returnNumber: true, createdAt: true, refundMethod: true, refundAmount: true } },
          exchangeForReturn: { select: { id: true, returnNumber: true } },
        },
      });
      if (!sale) throw new NotFoundDomainError('Sale', saleId);

      const business = await tx.business.findUniqueOrThrow({
        where: { id: actor.tenantId },
        select: {
          name: true,
          legalName: true,
          taxNumber: true,
          registrationNumber: true,
          phone: true,
          email: true,
          addressLine: true,
          city: true,
          country: true,
          logoUrl: true,
          receiptHeader: true,
          receiptFooter: true,
          currency: true,
          timezone: true,
        },
      });

      const register = sale.shift.cashRegisterId
        ? await tx.cashRegister.findFirst({
            where: { id: sale.shift.cashRegisterId, businessId: actor.tenantId },
            select: { id: true, name: true, code: true },
          })
        : null;

      const cashier = await tx.user.findFirst({
        where: { id: sale.createdBy ?? sale.shift.openedBy, businessId: actor.tenantId },
        select: { id: true, name: true },
      });

      const { paidAmount, remainingAmount, paymentStatus } = await computePaymentSummary(tx, actor.tenantId, sale);

      // The tax breakdown a receipt has to show: one line per RATE, built
      // from each line's own snapshot rather than from today's tax
      // configuration. A sale that mixed a 14% line with an exempt one
      // prints both, and keeps printing both after the rate changes.
      const taxByRate = new Map<string, { ratePercent: string; taxableAmount: Prisma.Decimal; taxAmount: Prisma.Decimal }>();
      for (const item of sale.items) {
        const rate = item.taxRateSnapshot ? item.taxRateSnapshot.toString() : '0';
        const net = item.lineTotal.minus(item.taxAmount);
        const bucket = taxByRate.get(rate) ?? {
          ratePercent: rate,
          taxableAmount: new Prisma.Decimal(0),
          taxAmount: new Prisma.Decimal(0),
        };
        bucket.taxableAmount = bucket.taxableAmount.plus(net);
        bucket.taxAmount = bucket.taxAmount.plus(item.taxAmount);
        taxByRate.set(rate, bucket);
      }

      // The loyalty a customer expects to see on their slip. Read from the
      // append-only ledger, which is where those events actually live.
      const points = sale.customerId
        ? await tx.customerPoints.findMany({
            where: { businessId: actor.tenantId, referenceType: 'Sale', referenceId: sale.id },
            select: { type: true, points: true, basisAmount: true },
          })
        : [];

      return {
        business: {
          ...business,
          // The name to print: the registered legal name when the business
          // has given one, otherwise its trading name.
          displayName: business.legalName ?? business.name,
        },
        branch: sale.branch,
        register,
        cashier,
        sale: {
          id: sale.id,
          saleNumber: sale.saleNumber,
          createdAt: sale.createdAt,
          notes: sale.notes,
          subtotal: sale.subtotal.toString(),
          discountAmount: sale.discountAmount.toString(),
          taxAmount: sale.taxAmount.toString(),
          totalAmount: sale.totalAmount.toString(),
          paidAmount: paidAmount.toString(),
          remainingAmount: remainingAmount.toString(),
          paymentStatus,
          // Phase 10 (Exchanges): when this sale replaced returned goods,
          // the receipt says so and names the return.
          exchangeForReturn: sale.exchangeForReturn,
        },
        customer: sale.customer,
        items: sale.items.map((i) => ({
          id: i.id,
          sku: i.variant.sku,
          name: i.variant.product.name,
          alternativeName: i.variant.product.alternativeName,
          quantity: i.quantity.toString(),
          unitPrice: i.unitPrice.toString(),
          discountAmount: i.discountAmount.toString(),
          taxAmount: i.taxAmount.toString(),
          taxRatePercent: i.taxRateSnapshot ? i.taxRateSnapshot.toString() : null,
          taxExempt: i.taxExempt,
          lineTotal: i.lineTotal.toString(),
          quantityReturned: i.quantityReturned.toString(),
          serials: i.SaleItemSerial.map((x) => x.serialNumber.serial),
        })),
        taxBreakdown: [...taxByRate.values()]
          .sort((a, b) => Number(a.ratePercent) - Number(b.ratePercent))
          .map((b) => ({
            ratePercent: b.ratePercent,
            taxableAmount: b.taxableAmount.toString(),
            taxAmount: b.taxAmount.toString(),
          })),
        payments: sale.payments.map((p) => ({
          method: p.method,
          amount: p.amount.toString(),
          reference: p.reference,
          receivedAt: p.receivedAt,
        })),
        loyalty: {
          earned: points.filter((p) => p.type === 'EARN').reduce((s, p) => s.plus(p.points), new Prisma.Decimal(0)).toString(),
          redeemed: points
            .filter((p) => p.type === 'REDEEM')
            .reduce((s, p) => s.plus(p.points.abs()), new Prisma.Decimal(0))
            .toString(),
        },
        // Reprints have to show what came back, or a customer holding a
        // receipt for goods they returned has no way to tell.
        returns: sale.returns.map((r) => ({
          returnNumber: r.returnNumber,
          createdAt: r.createdAt,
          refundMethod: r.refundMethod,
          refundAmount: r.refundAmount ? r.refundAmount.toString() : null,
        })),
      };
    });
  }
}
