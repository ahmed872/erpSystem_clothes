import { Injectable } from '@nestjs/common';
import type { UpdateWarehouseInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class UpdateWarehouseUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, warehouseId: string, input: UpdateWarehouseInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.warehouse.findFirst({ where: { id: warehouseId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('Warehouse', warehouseId);

      if (input.isDefault) {
        await tx.warehouse.updateMany({
          where: { branchId: before.branchId, isDefault: true, NOT: { id: warehouseId } },
          data: { isDefault: false },
        });
      }

      const after = await tx.warehouse.update({
        where: { id: warehouseId },
        data: {
          name: input.name ?? undefined,
          isDefault: input.isDefault ?? undefined,
          isActive: input.isActive ?? undefined,
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Warehouse',
        entityId: warehouseId,
        before,
        after,
      });

      return after;
    });
  }
}
