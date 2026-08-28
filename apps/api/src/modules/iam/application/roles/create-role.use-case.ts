import { Injectable } from '@nestjs/common';
import type { CreateRoleInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class CreateRoleUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: CreateRoleInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const duplicate = await tx.role.findFirst({ where: { businessId: actor.tenantId, name: input.name } });
      if (duplicate) throw new ConflictDomainError(`A role named "${input.name}" already exists`);

      const permissions = await tx.permission.findMany({ where: { code: { in: input.permissionCodes } } });
      if (permissions.length !== new Set(input.permissionCodes).size) {
        throw new ValidationFailedError('One or more permissionCodes do not exist');
      }

      const role = await tx.role.create({
        data: {
          businessId: actor.tenantId,
          name: input.name,
          isSystem: false,
          rolePermissions: { createMany: { data: permissions.map((p) => ({ permissionId: p.id })) } },
        },
        include: { rolePermissions: { include: { permission: true } } },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Role',
        entityId: role.id,
        after: { name: role.name, permissionCodes: input.permissionCodes },
      });

      return role;
    });
  }
}
