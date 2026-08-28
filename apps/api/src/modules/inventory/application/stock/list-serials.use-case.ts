import { Injectable } from '@nestjs/common';
import { SerialNumberStatus } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class ListSerialsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, variantId?: string, status?: SerialNumberStatus) {
    return this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.serialNumber.findMany({
        where: { businessId: actor.tenantId, variantId, status },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }
}
