import { Injectable } from '@nestjs/common';
import type { ChangeOwnPasswordInput, ResetUserPasswordInput } from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { PasswordHasherService } from '../../../../common/security/password-hasher.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Phase 10 (10G) — password change and administrative reset.
 *
 * TWO OPERATIONS, DELIBERATELY DIFFERENT:
 *
 *   change  the user proves they know the current password
 *   reset   an administrator does not, and the permission is the check
 *
 * The reset path exists because it is what actually happens in a shop:
 * someone forgets their password and the owner sets a new one. There is
 * no self-service email or SMS reset - delivery is outside Phase 10's
 * approved scope, and a reset link nobody can receive is worse than none.
 *
 * EVERY SUCCESSFUL CHANGE REVOKES EVERY REFRESH TOKEN THE USER HOLDS.
 * That is the whole point of changing a password after a suspected
 * compromise: a stolen refresh token outlives the password it was minted
 * under otherwise, and the change would be theatre. The user is signed out
 * everywhere, including on the device that made the change - which is the
 * honest behaviour, not an oversight.
 *
 * The password itself is never audited, in either direction. The audit row
 * records that a change happened, by whom, to whom - never the value, and
 * never the hash.
 */
@Injectable()
export class ChangePasswordUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasherService,
  ) {}

  async changeOwn(actor: RequestUser, input: ChangeOwnPasswordInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: actor.id, businessId: actor.tenantId },
        select: { id: true, passwordHash: true, status: true },
      });
      if (!user) throw new NotFoundDomainError('User', actor.id);

      const ok = await this.hasher.verify(user.passwordHash, input.currentPassword);
      if (!ok) {
        // Deliberately a 422 with a flat message: which of the two
        // passwords was wrong is not information worth handing out.
        throw new ValidationFailedError('The current password is incorrect');
      }
      if (input.currentPassword === input.newPassword) {
        throw new ValidationFailedError('The new password must be different from the current one');
      }

      await this.apply(tx, actor, user.id, input.newPassword, 'Password changed by the account holder');
      return { revokedSessions: await this.revokeSessions(tx, user.id) };
    });
  }

  async resetForUser(actor: RequestUser, userId: string, input: ResetUserPasswordInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: userId, businessId: actor.tenantId },
        select: { id: true, status: true },
      });
      if (!user) throw new NotFoundDomainError('User', userId);
      if (user.status !== 'ACTIVE') {
        throw new ConflictDomainError('A suspended user cannot be given a new password - reactivate them first', {
          userId,
          status: user.status,
        });
      }

      await this.apply(tx, actor, user.id, input.newPassword, 'Password reset by an administrator');
      return { revokedSessions: await this.revokeSessions(tx, user.id) };
    });
  }

  private async apply(tx: TenantTx, actor: RequestUser, userId: string, newPassword: string, reason: string) {
    const passwordHash = await this.hasher.hash(newPassword);
    await tx.user.update({ where: { id: userId }, data: { passwordHash, updatedBy: actor.id } });

    // The audit row records THAT a password changed, never the value and
    // never the hash - an audit trail is not a place to leak credentials.
    await this.audit.record(tx, {
      businessId: actor.tenantId,
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'User',
      entityId: userId,
      reason,
    });
  }

  /**
   * Revokes every live refresh token the user holds. Already-revoked rows
   * are left alone so the original revocation time survives.
   */
  private async revokeSessions(tx: TenantTx, userId: string) {
    const result = await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
