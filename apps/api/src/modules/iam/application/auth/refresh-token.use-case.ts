import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
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
 * revoked and a brand new one issued, so a stolen refresh token can be
 * used at most once.
 *
 * Phase 11 — REUSE DETECTION. Rotation alone leaves a real hole. If a
 * token is stolen and the thief redeems it first, the thief holds a valid
 * new token and the legitimate client's next refresh simply fails; the
 * client signs in again and never learns anything was wrong, while the
 * thief's session continues. Rotation detects nothing on its own - it only
 * guarantees that ONE of the two parties fails.
 *
 * A revoked-but-otherwise-valid token being presented is the signal, and
 * it has exactly one innocent explanation (a client racing itself) and one
 * dangerous one (a stolen token). Treating both as theft costs the honest
 * client a re-login and costs the thief the whole session, so the whole
 * FAMILY is revoked: every live refresh token that user holds. Both
 * parties are then signed out, which is the only outcome that does not
 * leave an attacker holding a working session.
 */
@Injectable()
export class RefreshTokenUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AuthTokenService,
    private readonly audit: AuditService,
  ) {}

  async execute(refreshToken: string): Promise<RefreshResult> {
    const claims = this.tokens.verifyRefreshTokenSignature(refreshToken);

    // IMPORTANT, and the same rule LoginUseCase follows: never throw from
    // inside `withTenant`'s callback here. A thrown error rolls back the
    // whole transaction - which would discard the family revocation and
    // the audit row written on the reuse path, leaving the attacker's
    // session alive and no record that anything happened. The callback
    // returns a discriminated result and this method throws AFTER the
    // transaction has committed.
    const outcome = await this.prisma.withTenant(claims.tenantId, async (tx) => {
      const row = await tx.refreshToken.findUnique({ where: { id: claims.jti } });
      const presentedTokenIsGenuine =
        row !== null && row.userId === claims.sub && row.tokenHash === hashRefreshToken(refreshToken);

      // THE REUSE SIGNAL: a genuine, unexpired token that has already been
      // spent. Someone is holding a copy of a token that was rotated away,
      // so every live token this user has is treated as compromised.
      if (presentedTokenIsGenuine && row.revokedAt !== null && row.expiresAt.getTime() >= Date.now()) {
        const revoked = await tx.refreshToken.updateMany({
          where: { userId: row.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.audit.record(tx, {
          businessId: claims.tenantId,
          userId: row.userId,
          action: 'LOGIN_FAILED',
          entityType: 'RefreshToken',
          entityId: row.id,
          reason: `refresh_token_reuse_detected: revoked ${revoked.count} live session(s)`,
        });
        return { ok: false as const };
      }

      if (!presentedTokenIsGenuine || row.revokedAt !== null || row.expiresAt.getTime() < Date.now()) {
        return { ok: false as const };
      }

      const user = await tx.user.findUnique({ where: { id: claims.sub } });
      if (!user || user.status !== 'ACTIVE') {
        return { ok: false as const };
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

      return {
        ok: true as const,
        result: { accessToken: access.token, refreshToken: next.token, expiresIn: access.expiresIn },
      };
    });

    if (!outcome.ok) {
      // One message for every failure - expired, revoked, forged, reused,
      // or belonging to a suspended user. Distinguishing them would tell a
      // holder of a stolen token exactly what they are holding.
      throw new UnauthorizedDomainError('Invalid or expired refresh token');
    }
    return outcome.result;
  }
}
