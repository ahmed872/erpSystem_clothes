import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreateSalePaymentInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { lockSale } from '../../domain/lock-sale';

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
  ) {}

  async execute(actor: RequestUser, saleId: string, input: CreateSalePaymentInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.salePayment.findFirst({ where: { businessId: actor.tenantId, idempotencyKey: input.idempotencyKey } });
        if (existing) return existing;
      }

      await lockSale(tx, actor.tenantId, saleId);
      const sale = await tx.sale.findFirst({ where: { id: saleId, businessId: actor.tenantId } });
      if (!sale) throw new NotFoundDomainError('Sale', saleId);

      const paidSoFar = await tx.salePayment.aggregate({ where: { businessId: actor.tenantId, saleId }, _sum: { amount: true } });
      const alreadyPaid = paidSoFar._sum.amount ?? new Prisma.Decimal(0);
      const remaining = sale.totalAmount.minus(alreadyPaid);

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
