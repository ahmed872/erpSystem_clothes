import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { AuthTokenService } from '../../domain/auth-token.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class LogoutUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: AuthTokenService,
  ) {}

  async execute(actor: RequestUser, refreshToken: string): Promise<void> {
    const claims = this.tokens.verifyRefreshTokenSignature(refreshToken);
    if (claims.sub !== actor.id || claims.tenantId !== actor.tenantId) {
      // Not this user's token - nothing to revoke, and we don't leak why.
      return;
    }

    await this.prisma.withTenant(actor.tenantId, async (tx) => {
      await tx.refreshToken.updateMany({
        where: { id: claims.jti, userId: actor.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'LOGOUT',
        entityType: 'User',
        entityId: actor.id,
      });
    });
  }
}
