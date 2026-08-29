import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class ListPeriodsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const periods = await tx.fiscalPeriod.findMany({ where: { businessId: actor.tenantId }, orderBy: { startDate: 'desc' }, take: 200 });
      return { data: periods };
    });
  }
}
