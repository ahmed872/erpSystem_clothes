import { Injectable } from '@nestjs/common';
import type { AddBarcodeInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

@Injectable()
export class BarcodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async add(actor: RequestUser, variantId: string, input: AddBarcodeInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const variant = await tx.productVariant.findFirst({ where: { id: variantId, businessId: actor.tenantId } });
      if (!variant) throw new NotFoundDomainError('ProductVariant', variantId);

      if (input.productUomId) {
        const productUom = await tx.productUom.findFirst({
          where: { id: input.productUomId, businessId: actor.tenantId, productId: variant.productId },
        });
        if (!productUom) throw new ValidationFailedError('productUomId does not belong to this variant\'s product');
      }

      const duplicate = await tx.barcode.findFirst({ where: { businessId: actor.tenantId, code: input.code } });
      if (duplicate) throw new ConflictDomainError(`Barcode "${input.code}" is already in use`);

      if (input.isPrimary) {
        await tx.barcode.updateMany({ where: { variantId, isPrimary: true }, data: { isPrimary: false } });
      }

      const barcode = await tx.barcode.create({
        data: {
          businessId: actor.tenantId,
          variantId,
          productUomId: input.productUomId,
          code: input.code,
          isPrimary: input.isPrimary,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Barcode',
        entityId: barcode.id,
        after: barcode,
      });

      return barcode;
    });
  }

  async remove(actor: RequestUser, barcodeId: string): Promise<void> {
    await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const barcode = await tx.barcode.findFirst({ where: { id: barcodeId, businessId: actor.tenantId } });
      if (!barcode) throw new NotFoundDomainError('Barcode', barcodeId);

      await tx.barcode.delete({ where: { id: barcodeId } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'DELETE',
        entityType: 'Barcode',
        entityId: barcodeId,
        before: barcode,
      });
    });
  }
}
