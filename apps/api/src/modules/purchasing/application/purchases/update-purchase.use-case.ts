import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { UpdatePurchaseInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { lockPurchase } from '../../domain/lock-purchase';
import { DOCUMENT_LINE_ORDER } from '../../domain/document-line-order';

/**
 * Only a DRAFT purchase may be edited - once APPROVED, the business has
 * committed to the order and any change must go through the
 * approve/cancel/receive/return lifecycle instead. Item rows for
 * variants no longer in the new item list are deleted outright, which is
 * safe ONLY because a DRAFT purchase's items can never yet have a
 * PurchaseReceiptItem/PurchaseReturnItem referencing them (both carry an
 * ON DELETE RESTRICT FK to purchase_items, so the database itself would
 * refuse the delete if that were ever untrue).
 */
@Injectable()
export class UpdatePurchaseUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, purchaseId: string, input: UpdatePurchaseInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      await lockPurchase(tx, actor.tenantId, purchaseId);
      const before = await tx.purchase.findFirst({
        where: { id: purchaseId, businessId: actor.tenantId },
        include: { items: { orderBy: DOCUMENT_LINE_ORDER } },
      });
      if (!before) throw new NotFoundDomainError('Purchase', purchaseId);
      if (before.status !== 'DRAFT') {
        throw new ConflictDomainError(`Only a DRAFT purchase can be edited (current status: ${before.status})`);
      }

      if (input.supplierId && input.supplierId !== before.supplierId) {
        const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, businessId: actor.tenantId } });
        if (!supplier) throw new NotFoundDomainError('Supplier', input.supplierId);
        if (!supplier.isActive) throw new ValidationFailedError('Cannot assign an inactive supplier to a purchase');
      }

      let subtotal = before.subtotal;
      let taxAmount = before.taxAmount;
      let discountAmount = before.discountAmount;
      let totalAmount = before.totalAmount;

      if (input.items) {
        const variantIds = input.items.map((i) => i.variantId);
        if (new Set(variantIds).size !== variantIds.length) {
          throw new ValidationFailedError('Duplicate variantId in purchase items');
        }
        const variants = await tx.productVariant.findMany({ where: { id: { in: variantIds }, businessId: actor.tenantId } });
        if (variants.length !== variantIds.length) {
          const found = new Set(variants.map((v) => v.id));
          throw new NotFoundDomainError('ProductVariant', variantIds.filter((id) => !found.has(id)).join(', '));
        }

        subtotal = new Prisma.Decimal(0);
        taxAmount = new Prisma.Decimal(0);
        discountAmount = new Prisma.Decimal(0);
        for (const item of input.items) {
          const lineSubtotal = new Prisma.Decimal(item.unitCost).times(item.quantityOrdered);
          subtotal = subtotal.plus(lineSubtotal);
          taxAmount = taxAmount.plus(item.taxAmount);
          discountAmount = discountAmount.plus(item.discountAmount);
        }
        totalAmount = subtotal.plus(taxAmount).minus(discountAmount);

        await tx.purchaseItem.deleteMany({ where: { purchaseId } });
        await tx.purchaseItem.createMany({
          data: input.items.map((item) => ({
            businessId: actor.tenantId,
            purchaseId,
            variantId: item.variantId,
            quantityOrdered: item.quantityOrdered,
            unitCost: item.unitCost,
            taxAmount: item.taxAmount,
            discountAmount: item.discountAmount,
            lineTotal: new Prisma.Decimal(item.unitCost).times(item.quantityOrdered).plus(item.taxAmount).minus(item.discountAmount),
          })),
        });
      }

      const updated = await tx.purchase.update({
        where: { id: purchaseId },
        data: {
          supplierId: input.supplierId,
          expectedDate: input.expectedDate,
          notes: input.notes,
          subtotal,
          taxAmount,
          discountAmount,
          totalAmount,
        },
        include: { items: { orderBy: DOCUMENT_LINE_ORDER } },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Purchase',
        entityId: purchaseId,
        before,
        after: updated,
      });

      return updated;
    });
  }
}
