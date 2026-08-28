import { Injectable } from '@nestjs/common';
import type { LoginInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { PasswordHasherService } from '../../../../common/security/password-hasher.service';
import { AuthTokenService } from '../../domain/auth-token.service';
import { hashRefreshToken } from '../../domain/token-hash';
import { addDuration } from '../../domain/duration';
import { UnauthorizedDomainError } from '../../../../common/errors/domain-error';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; name: string; email: string };
}

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Deliberately returns the same generic "Invalid email or password"
 * message whether the business slug, the email, or the password was
 * wrong, to avoid leaking which part was incorrect (tenant/user
 * enumeration). Every failure path that reaches a resolved tenant is
 * still recorded as a LOGIN_FAILED audit row for that tenant.
 */
@Injectable()
export class LoginUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasherService,
    private readonly tokens: AuthTokenService,
  ) {}

  async execute(input: LoginInput, meta: RequestMeta): Promise<LoginResult> {
    const business = await this.prisma.withoutTenant((tx) =>
      tx.business.findUnique({ where: { slug: input.businessSlug }, select: { id: true, status: true } }),
    );
    if (!business || business.status !== 'ACTIVE') {
      throw new UnauthorizedDomainError('Invalid email or password');
    }

    // IMPORTANT: never throw from inside `withTenant`'s callback here - a
    // thrown error rolls back the whole DB transaction, which would also
    // discard the LOGIN_FAILED audit row we just wrote. Instead the
    // callback returns a discriminated result, and this method throws
    // AFTER the transaction (containing the audit row) has committed.
    const outcome = await this.prisma.withTenant(business.id, async (tx) => {
      const user = await tx.user.findUnique({
        where: { businessId_email: { businessId: business.id, email: input.email } },
      });

      if (!user || user.status !== 'ACTIVE') {
        await this.audit.record(tx, {
          businessId: business.id,
          action: 'LOGIN_FAILED',
          entityType: 'User',
          reason: 'unknown_email_or_inactive',
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });
        return { ok: false as const };
      }

      const passwordOk = await this.hasher.verify(user.passwordHash, input.password);
      if (!passwordOk) {
        await this.audit.record(tx, {
          businessId: business.id,
          userId: user.id,
          action: 'LOGIN_FAILED',
          entityType: 'User',
          entityId: user.id,
          reason: 'bad_password',
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });
        return { ok: false as const };
      }

      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

      const access = this.tokens.issueAccessToken({ userId: user.id, tenantId: business.id, email: user.email });
      const refresh = this.tokens.issueRefreshToken({ userId: user.id, tenantId: business.id });

      await tx.refreshToken.create({
        data: {
          id: refresh.jti,
          userId: user.id,
          tokenHash: hashRefreshToken(refresh.token),
          expiresAt: addDuration(new Date(), refresh.expiresIn),
        },
      });

      await this.audit.record(tx, {
        businessId: business.id,
        userId: user.id,
        action: 'LOGIN',
        entityType: 'User',
        entityId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      });

      return {
        ok: true as const,
        result: {
          accessToken: access.token,
          refreshToken: refresh.token,
          expiresIn: access.expiresIn,
          user: { id: user.id, name: user.name, email: user.email },
        },
      };
    });

    if (!outcome.ok) {
      throw new UnauthorizedDomainError('Invalid email or password');
    }
    return outcome.result;
  }
}
