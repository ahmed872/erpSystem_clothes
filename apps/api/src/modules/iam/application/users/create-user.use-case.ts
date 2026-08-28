import { Injectable } from '@nestjs/common';
import type { CreateUserInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { PasswordHasherService } from '../../../../common/security/password-hasher.service';
import { ConflictDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { USER_SAFE_SELECT } from './user-select';

@Injectable()
export class CreateUserUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasherService,
  ) {}

  async execute(actor: RequestUser, input: CreateUserInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const roles = await tx.role.findMany({ where: { id: { in: input.roleIds }, businessId: actor.tenantId } });
      if (roles.length !== input.roleIds.length) {
        throw new ValidationFailedError('One or more roleIds do not belong to this business');
      }

      if (input.branchIds.length > 0) {
        const branches = await tx.branch.findMany({
          where: { id: { in: input.branchIds }, businessId: actor.tenantId },
        });
        if (branches.length !== input.branchIds.length) {
          throw new ValidationFailedError('One or more branchIds do not belong to this business');
        }
      }

      const existing = await tx.user.findUnique({
        where: { businessId_email: { businessId: actor.tenantId, email: input.email } },
      });
      if (existing) throw new ConflictDomainError(`A user with email "${input.email}" already exists`);

      const passwordHash = await this.hasher.hash(input.password);
      const user = await tx.user.create({
        data: {
          businessId: actor.tenantId,
          name: input.name,
          email: input.email,
          passwordHash,
          status: 'ACTIVE',
          createdBy: actor.id,
          userRoles: { createMany: { data: input.roleIds.map((roleId) => ({ roleId })) } },
          userBranches: { createMany: { data: input.branchIds.map((branchId) => ({ branchId })) } },
        },
        select: USER_SAFE_SELECT,
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'User',
        entityId: user.id,
        after: { name: user.name, email: user.email, roleIds: input.roleIds, branchIds: input.branchIds },
      });

      return user;
    });
  }
}
