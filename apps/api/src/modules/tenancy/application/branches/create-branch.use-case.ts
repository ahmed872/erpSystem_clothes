import { Injectable } from '@nestjs/common';
import type { CreateBranchInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class CreateBranchUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: CreateBranchInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const duplicate = await tx.branch.findFirst({
        where: { businessId: actor.tenantId, name: input.name },
      });
      if (duplicate) throw new ConflictDomainError(`A branch named "${input.name}" already exists`);

      const branch = await tx.branch.create({
        data: {
          businessId: actor.tenantId,
          name: input.name,
          address: input.address,
          phone: input.phone,
          createdBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Branch',
        entityId: branch.id,
        after: branch,
      });

      return branch;
    });
  }
}
