import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class DeleteRoleUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, roleId: string): Promise<void> {
    await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const role = await tx.role.findFirst({
        where: { id: roleId, businessId: actor.tenantId },
        include: { _count: { select: { userRoles: true } } },
      });
      if (!role) throw new NotFoundDomainError('Role', roleId);
      if (role.isSystem) throw new ConflictDomainError('Built-in role templates cannot be deleted');
      if (role._count.userRoles > 0) {
        throw new ConflictDomainError('Cannot delete a role that is still assigned to users');
      }

      await tx.role.delete({ where: { id: roleId } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'DELETE',
        entityType: 'Role',
        entityId: roleId,
        before: { name: role.name },
      });
    });
  }
}
