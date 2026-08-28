import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class GetStockTransferUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, transferId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const transfer = await tx.stockTransfer.findFirst({
        where: { id: transferId, businessId: actor.tenantId },
        include: { sourceWarehouse: true, destinationWarehouse: true, items: { include: { variant: { select: { id: true, sku: true } } } } },
      });
      if (!transfer) throw new NotFoundDomainError('StockTransfer', transferId);
      return transfer;
    });
  }
}
