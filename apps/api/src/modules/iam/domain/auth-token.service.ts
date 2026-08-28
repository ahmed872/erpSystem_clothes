import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';

export interface AccessTokenClaims {
  sub: string;
  tenantId: string;
  email: string;
  type: 'access';
}

export interface RefreshTokenClaims {
  sub: string;
  tenantId: string;
  jti: string;
  type: 'refresh';
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenId: string;
  expiresIn: number;
}

/**
 * Access tokens are stateless JWTs (signature + expiry only, no DB hit).
 * Refresh tokens are ALSO signed JWTs (not opaque random strings) so the
 * tenant id can be recovered from the token itself before any database
 * query - this is what lets refresh-token lookup happen inside a
 * correctly tenant-scoped RLS transaction without a chicken-and-egg
 * problem (see PrismaService.withTenant). Each refresh token additionally
 * has a server-side row (RefreshToken, keyed by jti) recording its hash
 * and revocation state, so it remains individually revocable (logout,
 * rotation) unlike a purely stateless token.
 */
@Injectable()
export class AuthTokenService {
  constructor(private readonly jwt: JwtService) {}

  private get accessSecret() {
    const s = process.env.JWT_ACCESS_SECRET;
    if (!s) throw new Error('JWT_ACCESS_SECRET is not set');
    return s;
  }

  private get refreshSecret() {
    const s = process.env.JWT_REFRESH_SECRET;
    if (!s) throw new Error('JWT_REFRESH_SECRET is not set');
    return s;
  }

  issueAccessToken(params: { userId: string; tenantId: string; email: string }): { token: string; expiresIn: number } {
    const expiresIn = process.env.JWT_ACCESS_TTL ?? '15m';
    const payload: AccessTokenClaims = {
      sub: params.userId,
      tenantId: params.tenantId,
      email: params.email,
      type: 'access',
    };
    const token = this.jwt.sign(payload, { secret: this.accessSecret, expiresIn });
    return { token, expiresIn: this.ttlToSeconds(expiresIn) };
  }

  issueRefreshToken(params: { userId: string; tenantId: string }): { token: string; jti: string; expiresIn: string } {
    const expiresIn = process.env.JWT_REFRESH_TTL ?? '30d';
    const jti = randomUUID();
    const payload: RefreshTokenClaims = {
      sub: params.userId,
      tenantId: params.tenantId,
      jti,
      type: 'refresh',
    };
    const token = this.jwt.sign(payload, { secret: this.refreshSecret, expiresIn });
    return { token, jti, expiresIn };
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    try {
      const claims = this.jwt.verify<AccessTokenClaims>(token, { secret: this.accessSecret });
      if (claims.type !== 'access') throw new Error('wrong token type');
      return claims;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  /** Verifies signature/expiry only. Caller must still check the DB row (hash, revocation) inside tenant context. */
  verifyRefreshTokenSignature(token: string): RefreshTokenClaims {
    try {
      const claims = this.jwt.verify<RefreshTokenClaims>(token, { secret: this.refreshSecret });
      if (claims.type !== 'refresh') throw new Error('wrong token type');
      return claims;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  private ttlToSeconds(ttl: string): number {
    const match = /^(\d+)([smhd])$/.exec(ttl);
    if (!match) return 900;
    const value = Number(match[1]);
    const unit = match[2];
    const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;
    return value * multiplier;
  }
}
