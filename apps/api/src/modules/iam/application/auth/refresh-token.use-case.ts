import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuthTokenService } from '../../domain/auth-token.service';
import { hashRefreshToken } from '../../domain/token-hash';
import { addDuration } from '../../domain/duration';
import { UnauthorizedDomainError } from '../../../../common/errors/domain-error';

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Rotates refresh tokens on every use: the presented token's row is
 * revoked and a brand new one issued, so a stolen-and-replayed refresh
 * token can be used at most once before the legitimate client's next
 * refresh fails loudly (a strong signal of token theft).
 */
@Injectable()
export class RefreshTokenUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AuthTokenService,
  ) {}

  async execute(refreshToken: string): Promise<RefreshResult> {
    const claims = this.tokens.verifyRefreshTokenSignature(refreshToken);

    return this.prisma.withTenant(claims.tenantId, async (tx) => {
      const row = await tx.refreshToken.findUnique({ where: { id: claims.jti } });
      if (
        !row ||
        row.userId !== claims.sub ||
        row.revokedAt !== null ||
        row.expiresAt.getTime() < Date.now() ||
        row.tokenHash !== hashRefreshToken(refreshToken)
      ) {
        throw new UnauthorizedDomainError('Invalid or expired refresh token');
      }

      const user = await tx.user.findUnique({ where: { id: claims.sub } });
      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedDomainError('Invalid or expired refresh token');
      }

      await tx.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });

      const access = this.tokens.issueAccessToken({ userId: user.id, tenantId: claims.tenantId, email: user.email });
      const next = this.tokens.issueRefreshToken({ userId: user.id, tenantId: claims.tenantId });

      await tx.refreshToken.create({
        data: {
          id: next.jti,
          userId: user.id,
          tokenHash: hashRefreshToken(next.token),
          expiresAt: addDuration(new Date(), next.expiresIn),
        },
      });

      return { accessToken: access.token, refreshToken: next.token, expiresIn: access.expiresIn };
    });
  }
}
