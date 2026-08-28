import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class ListSettingsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.setting.findMany({ where: { businessId: actor.tenantId }, orderBy: { key: 'asc' } }),
    );
  }
}
