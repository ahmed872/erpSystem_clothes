import { Injectable } from '@nestjs/common';
import type { UpdateRoleInput } from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * The two permission codes that make role administration reachable at all.
 *
 * `roles.view` is what lists the roles; `roles.edit` is what saves one.
 * Strip either from the role you are signed in through and the door you
 * just walked out of has no handle on the other side — there is no
 * break-glass path in the product, so the only remedy would be a DBA with
 * psql. That is the lockout Decision B rule 3 exists to prevent.
 */
const ROLE_ADMIN_CODES = ['roles.view', 'roles.edit'] as const;

/**
 * Phase 20 (Decision B) — EDITING A ROLE WITHOUT EDITING YOURSELF OUT OF
 * THE PRODUCT.
 *
 * The administration UI can now change a role's permissions, which makes
 * two failure modes reachable that were previously only theoretical:
 *
 *   1. An administrator opens the role they are signed in through, clears
 *      `roles.view`/`roles.edit`, and saves. The save succeeds, the next
 *      request is a 403, and nobody in the business can ever open the
 *      roles screen again.
 *
 *   2. A system role gets renamed. Role NAMES are not authorization
 *      anywhere in this codebase and must never become it — but the
 *      seeded templates are the vocabulary the product ships with, and a
 *      renamed `BUSINESS_OWNER` is still the same grant wearing a
 *      different label, which makes every operator conversation about it
 *      wrong. The last-owner lockout guard in `UpdateUserUseCase` reads
 *      that name too (Decision B rule 5: preserve it exactly), so a
 *      rename would quietly disarm a protection that is still live.
 *
 * BOTH ARE ENFORCED HERE, SERVER-SIDE. The browser mirrors rule 1 to
 * explain the disabled checkbox before the round trip, but the browser is
 * not the check — a direct `PATCH /roles/:id` gets the same 409.
 *
 * WHAT THIS DELIBERATELY IS NOT:
 *
 *   - It is NOT name-based authorization. Whether the caller holds this
 *     role is read from `user_roles` for the AUTHENTICATED caller
 *     (`actor.id`), never inferred from what the role is called.
 *   - It does NOT freeze system roles. Decision B rules 1 and 2 keep
 *     custom roles fully editable and system roles permission-editable;
 *     only the NAME of a system role is fixed.
 *   - It does NOT reach past the role being edited. A caller who holds
 *     several roles and strips `roles.edit` from one that does not grant
 *     it to them is unaffected: the guard fires only when THIS role is
 *     one of the caller's own and is currently granting the code the
 *     update would take away.
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

      // Decision B rule 4. Checked before anything is written, and before
      // the duplicate-name lookup, so the refusal is about the rule rather
      // than about a name collision it never got far enough to hit.
      if (input.name && input.name !== before.name && before.isSystem) {
        throw new ConflictDomainError('A built-in role template cannot be renamed', { roleId });
      }

      if (input.name && input.name !== before.name) {
        const duplicate = await tx.role.findFirst({ where: { businessId: actor.tenantId, name: input.name } });
        if (duplicate) throw new ConflictDomainError(`A role named "${input.name}" already exists`);
      }

      if (input.permissionCodes) {
        const permissions = await tx.permission.findMany({ where: { code: { in: input.permissionCodes } } });
        if (permissions.length !== new Set(input.permissionCodes).size) {
          throw new ValidationFailedError('One or more permissionCodes do not exist');
        }

        await this.assertCallerKeepsRoleAdministration(
          tx,
          actor,
          roleId,
          before.rolePermissions.map((rp) => rp.permission.code),
          permissions.map((p) => p.code),
        );

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
   * Decision B rule 3.
   *
   * The caller's roles are read from the join table for `actor.id` — the
   * user id on the verified access token — inside the same tenant-scoped
   * transaction as the write. Nothing here consults a role name, and
   * nothing is passed in from the request body: a caller cannot claim to
   * hold a role they do not.
   *
   * The refusal is a 409 rather than a 403: the caller genuinely holds
   * `roles.edit` and the request is well-formed. What is wrong is the
   * resulting STATE, which is the same thing the last-owner guard says
   * about suspending the final Business Owner.
   */
  private async assertCallerKeepsRoleAdministration(
    tx: TenantTx,
    actor: RequestUser,
    roleId: string,
    currentCodes: string[],
    nextCodes: string[],
  ): Promise<void> {
    const callerHoldsThisRole = await tx.userRole.findFirst({
      where: { userId: actor.id, roleId },
      select: { roleId: true },
    });
    if (!callerHoldsThisRole) return;

    const held = new Set(currentCodes);
    const next = new Set(nextCodes);
    const removed = ROLE_ADMIN_CODES.filter((code) => held.has(code) && !next.has(code));
    if (removed.length === 0) return;

    throw new ConflictDomainError(
      'This update would remove role administration from a role you hold, locking this business out of the roles screen',
      { roleId, removedPermissionCodes: removed },
    );
  }
}
