import { Injectable } from '@nestjs/common';
import type { UpdateUserInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { USER_SAFE_SELECT } from './user-select';

@Injectable()
export class UpdateUserUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, userId: string, input: UpdateUserInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.user.findFirst({
        where: { id: userId, businessId: actor.tenantId },
        select: { ...USER_SAFE_SELECT, userRoles: { select: { roleId: true, role: { select: { name: true } } } } },
      });
      if (!before) throw new NotFoundDomainError('User', userId);

      if (input.roleIds) {
        const roles = await tx.role.findMany({ where: { id: { in: input.roleIds }, businessId: actor.tenantId } });
        if (roles.length !== input.roleIds.length) {
          throw new ValidationFailedError('One or more roleIds do not belong to this business');
        }
      }
      if (input.branchIds) {
        const branches = await tx.branch.findMany({
          where: { id: { in: input.branchIds }, businessId: actor.tenantId },
        });
        if (branches.length !== input.branchIds.length) {
          throw new ValidationFailedError('One or more branchIds do not belong to this business');
        }
      }

      // Guard against locking the tenant out of ownership entirely: never
      // let the last ACTIVE user holding the BUSINESS_OWNER role be
      // suspended or stripped of that role.
      const wasOwner = before.userRoles.some((ur) => ur.role.name === 'BUSINESS_OWNER');
      let stillOwnerAfterUpdate = wasOwner;
      if (wasOwner && input.roleIds !== undefined) {
        const nextRoles = await tx.role.findMany({ where: { id: { in: input.roleIds } }, select: { name: true } });
        stillOwnerAfterUpdate = nextRoles.some((r) => r.name === 'BUSINESS_OWNER');
      }
      const losingOwnerRole = wasOwner && !stillOwnerAfterUpdate;
      const beingSuspended = input.status === 'SUSPENDED' && before.status === 'ACTIVE';
      if (wasOwner && (losingOwnerRole || beingSuspended)) {
        const otherActiveOwners = await tx.user.count({
          where: {
            businessId: actor.tenantId,
            status: 'ACTIVE',
            id: { not: userId },
            userRoles: { some: { role: { name: 'BUSINESS_OWNER' } } },
          },
        });
        if (otherActiveOwners === 0) {
          throw new ConflictDomainError('Cannot remove the last active Business Owner of this business');
        }
      }

      if (input.roleIds) {
        await tx.userRole.deleteMany({ where: { userId } });
        await tx.userRole.createMany({ data: input.roleIds.map((roleId) => ({ userId, roleId })) });
      }
      if (input.branchIds) {
        await tx.userBranch.deleteMany({ where: { userId } });
        await tx.userBranch.createMany({ data: input.branchIds.map((branchId) => ({ userId, branchId })) });
      }

      const after = await tx.user.update({
        where: { id: userId },
        data: {
          name: input.name ?? undefined,
          status: input.status ?? undefined,
          updatedBy: actor.id,
        },
        select: USER_SAFE_SELECT,
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'User',
        entityId: userId,
        before,
        after: { ...after, roleIds: input.roleIds, branchIds: input.branchIds },
      });

      return after;
    });
  }
}
