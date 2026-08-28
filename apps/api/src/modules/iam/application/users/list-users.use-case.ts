import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { USER_SAFE_SELECT } from './user-select';

@Injectable()
export class ListUsersUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.user.findMany({
        where: { businessId: actor.tenantId },
        select: {
          ...USER_SAFE_SELECT,
          userRoles: { select: { role: { select: { id: true, name: true } } } },
          userBranches: { select: { branch: { select: { id: true, name: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }
}
