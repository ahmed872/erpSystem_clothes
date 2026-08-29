import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class ListShiftsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const shifts = await tx.shift.findMany({
        where: { businessId: actor.tenantId },
        orderBy: { openedAt: 'desc' },
        take: 200,
      });
      return { data: shifts };
    });
  }
}
