import { Injectable } from '@nestjs/common';
import type { AddProductUomInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

@Injectable()
export class ProductUomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async add(actor: RequestUser, productId: string, input: AddProductUomInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const product = await tx.product.findFirst({ where: { id: productId, businessId: actor.tenantId } });
      if (!product) throw new NotFoundDomainError('Product', productId);

      if (input.uomId === product.baseUomId) {
        throw new ValidationFailedError('The base UOM is implicit (factor 1) and cannot be added as an extra ProductUom');
      }

      const uom = await tx.uom.findFirst({ where: { id: input.uomId, businessId: actor.tenantId } });
      if (!uom) throw new NotFoundDomainError('Uom', input.uomId);

      const duplicate = await tx.productUom.findFirst({ where: { productId, uomId: input.uomId } });
      if (duplicate) throw new ConflictDomainError('This UOM is already configured for this product');

      const productUom = await tx.productUom.create({
        data: {
          businessId: actor.tenantId,
          productId,
          uomId: input.uomId,
          conversionFactor: input.conversionFactor,
          isPurchaseUom: input.isPurchaseUom,
          isSalesUom: input.isSalesUom,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'ProductUom',
        entityId: productUom.id,
        after: productUom,
      });

      return productUom;
    });
  }

  async remove(actor: RequestUser, productUomId: string): Promise<void> {
    await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const productUom = await tx.productUom.findFirst({ where: { id: productUomId, businessId: actor.tenantId } });
      if (!productUom) throw new NotFoundDomainError('ProductUom', productUomId);

      await tx.productUom.delete({ where: { id: productUomId } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'DELETE',
        entityType: 'ProductUom',
        entityId: productUomId,
        before: productUom,
      });
    });
  }
}
