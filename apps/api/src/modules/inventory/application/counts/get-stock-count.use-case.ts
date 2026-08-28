import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class GetStockCountUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, stockCountId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const stockCount = await tx.stockCount.findFirst({
        where: { id: stockCountId, businessId: actor.tenantId },
        include: { warehouse: true, items: { include: { variant: { select: { id: true, sku: true } } } } },
      });
      if (!stockCount) throw new NotFoundDomainError('StockCount', stockCountId);
      return stockCount;
    });
  }
}
