import { Injectable } from '@nestjs/common';
import type { UpdateBranchInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class UpdateBranchUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, branchId: string, input: UpdateBranchInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.branch.findFirst({ where: { id: branchId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('Branch', branchId);

      const after = await tx.branch.update({
        where: { id: branchId },
        data: {
          name: input.name ?? undefined,
          address: input.address ?? undefined,
          phone: input.phone ?? undefined,
          isActive: input.isActive ?? undefined,
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Branch',
        entityId: branchId,
        before,
        after,
      });

      return after;
    });
  }
}
