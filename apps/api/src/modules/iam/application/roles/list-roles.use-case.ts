import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class ListRolesUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.role.findMany({
        where: { businessId: actor.tenantId },
        include: { rolePermissions: { include: { permission: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }
}
