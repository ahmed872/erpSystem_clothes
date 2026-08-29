import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreateSalePaymentInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { lockSale } from '../../domain/lock-sale';
import { assertIdempotentReplayMatches } from '../../../../common/domain/idempotency';
import { computePaymentSummary } from '../../domain/payment-summary';
import { AccountingEngineService } from '../../../../engines/accounting/accounting-engine.service';
import { buildSalePaymentJournalLines } from '../../../accounting/domain/sale-payment-journal-lines';

function salePaymentFingerprint(saleId: string, amount: Prisma.Decimal.Value, method: string) {
  return { saleId, amount: new Prisma.Decimal(amount).toString(), method };
}

/**
 * Records a LATER payment against a credit sale (the initial tender(s)
 * are captured atomically inside CreateSaleUseCase itself - this is for
 * a customer paying down their balance afterwards). Bounded by
 * `totalAmount - SUM(existing payments)`, checked under the Sale-row
 * lock so two concurrent late payments against the same sale can never
 * together overpay it - unlike Purchasing's CreatePurchasePaymentUseCase
 * (Phase 4), which never bounded payments against the purchase total at
 * all and so needed no lock; this one has a real invariant to protect.
 * idempotencyKey from day one (Phase 5 rule #8/#9).
 */
@Injectable()
export class CreateSalePaymentUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accounting: AccountingEngineService,
  ) {}

  async execute(actor: RequestUser, saleId: string, input: CreateSalePaymentInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.salePayment.findFirst({ where: { businessId: actor.tenantId, idempotencyKey: input.idempotencyKey } });
        if (existing) {
          assertIdempotentReplayMatches(
            salePaymentFingerprint(existing.saleId, existing.amount, existing.method),
            salePaymentFingerprint(saleId, input.amount, input.method),
          );
          return existing;
        }
      }

      await lockSale(tx, actor.tenantId, saleId);
      const sale = await tx.sale.findFirst({ where: { id: saleId, businessId: actor.tenantId } });
      if (!sale) throw new NotFoundDomainError('Sale', saleId);

      const { remainingAmount: remaining } = await computePaymentSummary(tx, actor.tenantId, sale);

      if (remaining.lessThanOrEqualTo(0)) {
        throw new ConflictDomainError('This sale is already fully paid');
      }
      if (new Prisma.Decimal(input.amount).greaterThan(remaining)) {
        throw new ConflictDomainError(`Cannot pay ${input.amount} - only ${remaining.toString()} remains outstanding on this sale`, {
          remaining: remaining.toString(),
          requested: input.amount,
        });
      }

      const payment = await tx.salePayment.create({
        data: {
          businessId: actor.tenantId,
          saleId,
          amount: input.amount,
          method: input.method,
          reference: input.reference,
          idempotencyKey: input.idempotencyKey,
          receivedBy: actor.id,
        },
      });

      if (sale.customerId) {
        await tx.customerTransaction.create({
          data: {
            businessId: actor.tenantId,
            customerId: sale.customerId,
            type: 'PAYMENT',
            amount: new Prisma.Decimal(input.amount).negated(),
            referenceType: 'Sale',
            referenceId: sale.id,
            description: `Payment against sale ${sale.saleNumber}`,
            createdBy: actor.id,
          },
        });
      }

      // Phase 6: post the accounting fact for this payment in the SAME
      // transaction.
      const paymentJournalLines = await buildSalePaymentJournalLines(tx, actor.tenantId, new Prisma.Decimal(input.amount), input.method);
      if (paymentJournalLines.length > 0) {
        await this.accounting.postEntry(tx, {
          businessId: actor.tenantId,
          entryDate: new Date(),
          sourceType: 'SalePayment',
          sourceId: payment.id,
          description: `Payment against sale ${sale.saleNumber}`,
          createdBy: actor.id,
          lines: paymentJournalLines,
        });
      }

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'SalePayment',
        entityId: payment.id,
        after: payment,
      });

      return payment;
    });
  }
}
