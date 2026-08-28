import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type { CreatePurchaseInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { documentNumberFromId } from '../../domain/document-number';

/**
 * Creates a Purchase document in DRAFT status with its line items. This
 * is the "Purchase Document" responsibility only - it never touches
 * inventory or the supplier ledger (see Receiving/Returns use-cases for
 * those), matching the Phase 4 requirement to keep Document, Receiving,
 * Inventory Movement, and Payment cleanly separate.
 */
@Injectable()
export class CreatePurchaseUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: CreatePurchaseInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId, businessId: actor.tenantId } });
      if (!warehouse) throw new NotFoundDomainError('Warehouse', input.warehouseId);

      const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, businessId: actor.tenantId } });
      if (!supplier) throw new NotFoundDomainError('Supplier', input.supplierId);
      if (!supplier.isActive) throw new ValidationFailedError('Cannot create a purchase against an inactive supplier');

      const variantIds = input.items.map((i) => i.variantId);
      if (new Set(variantIds).size !== variantIds.length) {
        throw new ValidationFailedError('Duplicate variantId in purchase items');
      }
      const variants = await tx.productVariant.findMany({ where: { id: { in: variantIds }, businessId: actor.tenantId } });
      if (variants.length !== variantIds.length) {
        const found = new Set(variants.map((v) => v.id));
        const missing = variantIds.filter((id) => !found.has(id));
        throw new NotFoundDomainError('ProductVariant', missing.join(', '));
      }

      let subtotal = new Prisma.Decimal(0);
      let taxAmount = new Prisma.Decimal(0);
      let discountAmount = new Prisma.Decimal(0);
      const itemsData = input.items.map((item) => {
        const lineSubtotal = new Prisma.Decimal(item.unitCost).times(item.quantityOrdered);
        const lineTax = new Prisma.Decimal(item.taxAmount);
        const lineDiscount = new Prisma.Decimal(item.discountAmount);
        const lineTotal = lineSubtotal.plus(lineTax).minus(lineDiscount);
        subtotal = subtotal.plus(lineSubtotal);
        taxAmount = taxAmount.plus(lineTax);
        discountAmount = discountAmount.plus(lineDiscount);
        return {
          businessId: actor.tenantId,
          variantId: item.variantId,
          quantityOrdered: item.quantityOrdered,
          unitCost: item.unitCost,
          taxAmount: item.taxAmount,
          discountAmount: item.discountAmount,
          lineTotal,
        };
      });
      const totalAmount = subtotal.plus(taxAmount).minus(discountAmount);

      const id = randomUUID();
      const purchase = await tx.purchase.create({
        data: {
          id,
          businessId: actor.tenantId,
          branchId: warehouse.branchId,
          warehouseId: input.warehouseId,
          supplierId: input.supplierId,
          // Deterministic from the client-generated id above (never a
          // shared counter/sequence) - see documentNumberFromId.
          purchaseNumber: documentNumberFromId('PO', id),
          expectedDate: input.expectedDate,
          notes: input.notes,
          subtotal,
          taxAmount,
          discountAmount,
          totalAmount,
          createdBy: actor.id,
          items: { create: itemsData },
        },
        include: { items: true },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Purchase',
        entityId: purchase.id,
        after: purchase,
      });

      return purchase;
    });
  }
}
