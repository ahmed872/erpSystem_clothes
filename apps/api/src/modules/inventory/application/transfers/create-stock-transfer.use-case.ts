import { Injectable } from '@nestjs/common';
import type { CreateStockTransferInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Creates a DRAFT transfer only - no stock is reserved or moved yet.
 * Availability is only actually checked (and source stock decremented)
 * when the transfer is sent (see SendStockTransferUseCase); Phase 3
 * deliberately does not add reservation semantics at Draft stage (that
 * belongs with Phase 5's "hold" concept once it exists - see
 * StockBalance.quantityReserved's doc comment in schema.prisma).
 */
@Injectable()
export class CreateStockTransferUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: CreateStockTransferInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const source = await tx.warehouse.findFirst({ where: { id: input.sourceWarehouseId, businessId: actor.tenantId } });
      if (!source) throw new NotFoundDomainError('Warehouse', input.sourceWarehouseId);
      const destination = await tx.warehouse.findFirst({ where: { id: input.destinationWarehouseId, businessId: actor.tenantId } });
      if (!destination) throw new NotFoundDomainError('Warehouse', input.destinationWarehouseId);

      const variantIds = input.items.map((i) => i.variantId);
      if (new Set(variantIds).size !== variantIds.length) {
        throw new ValidationFailedError('Duplicate variantId in transfer items');
      }
      const variants = await tx.productVariant.findMany({ where: { id: { in: variantIds }, businessId: actor.tenantId } });
      if (variants.length !== variantIds.length) {
        throw new ValidationFailedError('One or more variantIds do not belong to this business');
      }

      const transfer = await tx.stockTransfer.create({
        data: {
          businessId: actor.tenantId,
          sourceWarehouseId: input.sourceWarehouseId,
          destinationWarehouseId: input.destinationWarehouseId,
          createdBy: actor.id,
          items: { createMany: { data: input.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) } },
        },
        include: { items: true },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'StockTransfer',
        entityId: transfer.id,
        after: { sourceWarehouseId: input.sourceWarehouseId, destinationWarehouseId: input.destinationWarehouseId, itemCount: input.items.length },
      });

      return transfer;
    });
  }
}
