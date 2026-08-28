import { Injectable } from '@nestjs/common';
import type { CreateWarehouseInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class CreateWarehouseUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: CreateWarehouseInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const branch = await tx.branch.findFirst({
        where: { id: input.branchId, businessId: actor.tenantId },
      });
      if (!branch) throw new NotFoundDomainError('Branch', input.branchId);

      const duplicate = await tx.warehouse.findFirst({
        where: { branchId: input.branchId, name: input.name },
      });
      if (duplicate) throw new ConflictDomainError(`A warehouse named "${input.name}" already exists in this branch`);

      if (input.isDefault) {
        await tx.warehouse.updateMany({
          where: { branchId: input.branchId, isDefault: true },
          data: { isDefault: false },
        });
      }

      const warehouse = await tx.warehouse.create({
        data: {
          businessId: actor.tenantId,
          branchId: input.branchId,
          name: input.name,
          isDefault: input.isDefault ?? false,
          createdBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Warehouse',
        entityId: warehouse.id,
        after: warehouse,
      });

      return warehouse;
    });
  }
}
