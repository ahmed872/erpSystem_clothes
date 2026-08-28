import { Injectable } from '@nestjs/common';
import type { SubmitStockCountItemsInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/** Records counted quantities while a count is still DRAFT. Can be
 * called multiple times (e.g. counting in batches) before submitting. */
@Injectable()
export class SubmitStockCountItemsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, stockCountId: string, input: SubmitStockCountItemsInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const stockCount = await tx.stockCount.findFirst({ where: { id: stockCountId, businessId: actor.tenantId } });
      if (!stockCount) throw new NotFoundDomainError('StockCount', stockCountId);
      if (stockCount.status !== 'DRAFT') {
        throw new ConflictDomainError(`Items can only be entered while the count is DRAFT (current status: ${stockCount.status})`);
      }

      for (const item of input.items) {
        const existing = await tx.stockCountItem.findUnique({
          where: { stockCountId_variantId: { stockCountId, variantId: item.variantId } },
        });
        if (!existing) {
          throw new ValidationFailedError(`variantId ${item.variantId} is not part of this stock count`);
        }
        await tx.stockCountItem.update({
          where: { id: existing.id },
          data: { actualQuantity: item.actualQuantity, reason: item.reason },
        });
      }

      return tx.stockCount.findUniqueOrThrow({ where: { id: stockCountId }, include: { items: true } });
    });
  }
}
