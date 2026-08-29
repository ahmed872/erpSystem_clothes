import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { findActiveShift } from '../../domain/find-active-shift';

@Injectable()
export class GetActiveShiftUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => findActiveShift(tx, actor.tenantId, actor.id));
  }
}
