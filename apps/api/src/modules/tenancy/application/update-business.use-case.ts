import { Injectable } from '@nestjs/common';
import type { UpdateBusinessInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

@Injectable()
export class UpdateBusinessUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: UpdateBusinessInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.business.findUnique({ where: { id: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('Business', actor.tenantId);

      const after = await tx.business.update({
        where: { id: actor.tenantId },
        data: {
          name: input.name ?? undefined,
          currency: input.currency ?? undefined,
          timezone: input.timezone ?? undefined,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Business',
        entityId: actor.tenantId,
        before,
        after,
      });

      return after;
    });
  }
}
