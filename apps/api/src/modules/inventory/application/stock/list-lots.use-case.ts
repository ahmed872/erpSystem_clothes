import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class ListLotsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, variantId?: string) {
    return this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.inventoryLot.findMany({
        where: { businessId: actor.tenantId, variantId },
        orderBy: { expiryDate: 'asc' },
      }),
    );
  }
}
