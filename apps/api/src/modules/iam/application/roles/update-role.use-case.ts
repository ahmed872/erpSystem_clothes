import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { UpdateRoleInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Phase 20 (ERP administration) — THE TWO THINGS A ROLE UPDATE MAY NOT DO.
 *
 * Editing a role is the one write in this system that can revoke the
 * caller's own ability to make writes. Discovery reproduced it end to
 * end: an owner pointed this endpoint at their own role, cut its
 * permission set down to one code, and the tenant was permanently locked
 * out of its own administration — `GET /roles` 403, `PATCH` back 403,
 * and re-login did not help, because the role itself had been rewritten.
 * There is no super-admin and no recovery path by design, so the only
 * remedy was direct database access.
 *
 * TWO GUARDS, adopted as approved owner decision B ("protect self only"):
 *
 *   1. SELF-LOCKOUT. An update is refused when it would leave the caller
 *      without `roles.view` or `roles.edit`. The check is made against
 *      the caller's EFFECTIVE permissions as they would be AFTER the
 *      change — the union over all their roles with this role's set
 *      replaced — not against this role alone. That distinction matters:
 *      an administrator who holds two roles may legitimately strip
 *      administration out of one of them while the other still carries
 *      it, and a per-role check would refuse a safe edit. No role NAME
 *      is consulted anywhere; the relationship and the grants decide.
 *
 *   2. SYSTEM-ROLE RENAME. `DeleteRoleUseCase` already refuses to delete
 *      an `isSystem` role, while this use-case would happily rename one —
 *      the two disagreed about whether `isSystem` meant anything. A
 *      built-in template's NAME is now fixed. Its PERMISSION SET remains
 *      editable, deliberately: a tenant may reasonably decide their
 *      Cashier should not see stock, and decision B keeps that open.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE. No super-admin, no recovery
 * mechanism, no change to the permission model, and no protection of any
 * OTHER administrator — a caller with `roles.edit` can still remove
 * administration from a colleague, which is an ordinary administrative
 * act with an audit row behind it, not a lockout.
 */
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
        // Coherent with DeleteRoleUseCase, which already refuses to
        // remove a built-in template. Renaming one is the same kind of
        // act: the seeded templates are referenced by name in the
        // onboarding data and in the role matrix, so a rename makes a
        // tenant's roles stop meaning what the product says they mean.
        if (before.isSystem) throw new ConflictDomainError('Built-in role templates cannot be renamed');
        const duplicate = await tx.role.findFirst({ where: { businessId: actor.tenantId, name: input.name } });
        if (duplicate) throw new ConflictDomainError(`A role named "${input.name}" already exists`);
      }

      if (input.permissionCodes) {
        const permissions = await tx.permission.findMany({ where: { code: { in: input.permissionCodes } } });
        if (permissions.length !== new Set(input.permissionCodes).size) {
          throw new ValidationFailedError('One or more permissionCodes do not exist');
        }

        await this.refuseSelfLockout(tx, actor, roleId, input.permissionCodes);

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

  /**
   * Refuses an edit that would cost the CALLER their own `roles.view` or
   * `roles.edit`.
   *
   * Computed on the permissions the caller WOULD hold once the change
   * landed: every role they hold, with this one's set swapped for the
   * proposed one. A caller who does not hold this role at all is
   * unaffected and passes straight through — the guard exists to stop
   * self-lockout, not to freeze other people's roles.
   *
   * Runs BEFORE any write, so a refused update leaves the role exactly
   * as it was; the surrounding transaction would roll back anyway, but
   * checking first means the audit trail carries no phantom attempt.
   */
  private async refuseSelfLockout(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    roleId: string,
    proposedCodes: string[],
  ): Promise<void> {
    const callerRoles = await tx.userRole.findMany({
      where: { userId: actor.id },
      select: { roleId: true, role: { select: { rolePermissions: { select: { permission: { select: { code: true } } } } } } },
    });
    // Not the caller's role: nothing of theirs is at stake.
    if (!callerRoles.some((ur) => ur.roleId === roleId)) return;

    const afterChange = new Set<string>();
    for (const ur of callerRoles) {
      const codes =
        ur.roleId === roleId ? proposedCodes : ur.role.rolePermissions.map((rp) => rp.permission.code);
      for (const code of codes) afterChange.add(code);
    }

    const lost = SELF_ADMINISTRATION_CODES.filter((code) => !afterChange.has(code));
    if (lost.length > 0) {
      throw new ConflictDomainError(
        `This change would remove your own ${lost.join(' and ')}, leaving nobody able to edit roles. Grant it through another role you hold first.`,
      );
    }
  }
}

/**
 * The two grants that, once lost, cannot be granted back: without
 * `roles.edit` there is no way to repair a role, and without
 * `roles.view` there is no way to find the one to repair. Every other
 * permission a caller might remove from themselves is recoverable by
 * someone who still holds these.
 */
const SELF_ADMINISTRATION_CODES = ['roles.view', 'roles.edit'] as const;
