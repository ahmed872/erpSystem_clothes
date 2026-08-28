import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class ListStockTransfersUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.stockTransfer.findMany({
        where: { businessId: actor.tenantId },
        include: { sourceWarehouse: { select: { id: true, name: true } }, destinationWarehouse: { select: { id: true, name: true } }, items: true },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }
}
