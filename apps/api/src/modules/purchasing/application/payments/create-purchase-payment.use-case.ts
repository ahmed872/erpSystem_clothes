import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreatePurchasePaymentInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { AccountingEngineService } from '../../../../engines/accounting/accounting-engine.service';
import { buildPurchasePaymentJournalLines } from '../../../accounting/domain/purchase-journal-lines';

/**
 * Records money paid to a supplier against a Purchase. Deliberately NOT
 * wired to any FinancialAccount/JournalEntry - the Accounting Engine is
 * Phase 6's scope entirely, out of bounds here per explicit instruction.
 * This is the clean, additive integration boundary Phase 6 will read
 * from later (every PurchasePayment/SupplierTransaction is already a
 * complete, immutable record of what was paid, when, how, and against
 * which purchase) - not a parallel or fake accounting system.
 */
@Injectable()
export class CreatePurchasePaymentUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accounting: AccountingEngineService,
  ) {}

  async execute(actor: RequestUser, purchaseId: string, input: CreatePurchasePaymentInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const purchase = await tx.purchase.findFirst({ where: { id: purchaseId, businessId: actor.tenantId } });
      if (!purchase) throw new NotFoundDomainError('Purchase', purchaseId);

      const payment = await tx.purchasePayment.create({
        data: {
          businessId: actor.tenantId,
          purchaseId,
          supplierId: purchase.supplierId,
          amount: input.amount,
          method: input.method,
          reference: input.reference,
          notes: input.notes,
          paidBy: actor.id,
        },
      });

      await tx.supplierTransaction.create({
        data: {
          businessId: actor.tenantId,
          supplierId: purchase.supplierId,
          type: 'PAYMENT',
          amount: new Prisma.Decimal(input.amount).negated(),
          referenceType: 'PurchasePayment',
          referenceId: payment.id,
          description: `Payment against purchase ${purchase.purchaseNumber}`,
          createdBy: actor.id,
        },
      });

      // Phase 6: post the accounting fact for this payment in the SAME
      // transaction.
      const paymentJournalLines = await buildPurchasePaymentJournalLines(tx, actor.tenantId, new Prisma.Decimal(input.amount), input.method);
      if (paymentJournalLines.length > 0) {
        await this.accounting.postEntry(tx, {
          businessId: actor.tenantId,
          entryDate: new Date(),
          sourceType: 'PurchasePayment',
          sourceId: payment.id,
          description: `Payment against purchase ${purchase.purchaseNumber}`,
          createdBy: actor.id,
          lines: paymentJournalLines,
        });
      }

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'PurchasePayment',
        entityId: payment.id,
        after: payment,
      });

      return payment;
    });
  }
}
