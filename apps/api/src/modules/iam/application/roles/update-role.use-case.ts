import { Injectable } from '@nestjs/common';
import type { UpdateRoleInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class UpdateRoleUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, roleId: string, input: UpdateRoleInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.role.findFirst({
        where: { id: roleId, businessId: actor.tenantId },
        include: { rolePermissions: { include: { permission: true } } },
      });
      if (!before) throw new NotFoundDomainError('Role', roleId);

      if (input.name && input.name !== before.name) {
        const duplicate = await tx.role.findFirst({ where: { businessId: actor.tenantId, name: input.name } });
        if (duplicate) throw new ConflictDomainError(`A role named "${input.name}" already exists`);
      }

      if (input.permissionCodes) {
        const permissions = await tx.permission.findMany({ where: { code: { in: input.permissionCodes } } });
        if (permissions.length !== new Set(input.permissionCodes).size) {
          throw new ValidationFailedError('One or more permissionCodes do not exist');
        }
        await tx.rolePermission.deleteMany({ where: { roleId } });
        await tx.rolePermission.createMany({
          data: permissions.map((p) => ({ roleId, permissionId: p.id })),
        });
      }

      const after = await tx.role.update({
        where: { id: roleId },
        data: { name: input.name ?? undefined },
        include: { rolePermissions: { include: { permission: true } } },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Role',
        entityId: roleId,
        before: { name: before.name, permissionCodes: before.rolePermissions.map((rp) => rp.permission.code) },
        after: { name: after.name, permissionCodes: after.rolePermissions.map((rp) => rp.permission.code) },
      });

      return after;
    });
  }
}
