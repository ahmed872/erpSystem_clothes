import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class ListWarehousesUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, branchId?: string) {
    return this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.warehouse.findMany({
        where: { businessId: actor.tenantId, branchId: branchId ?? undefined },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }
}
