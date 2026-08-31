import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionCode } from '@retail/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { EffectivePermissionsService } from '../authorization/effective-permissions.service';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { RequestUser } from '../decorators/current-user.decorator';
import { AuditService } from '../../modules/audit/audit.service';

/**
 * Server-side authorization. Always re-reads the caller's effective
 * permission set (via EffectivePermissionsService) on every request
 * rather than trusting a snapshot embedded in the JWT, so revoking a
 * role/permission takes effect immediately rather than waiting for the
 * access token to expire. The frontend hiding a button is never a
 * substitute for this check (docs/architecture/PHASE-0-ARCHITECTURE.md
 * §9/§14).
 *
 * Phase 11 — EVERY DENIAL IS RECORDED. `PERMISSION_DENIED` existed in the
 * AuditAction enum since Phase 1 and nothing ever wrote it, so the one
 * question a security review always asks - "did anyone try to reach the
 * accounting module?" - had no answer. It is written HERE, in the single
 * place every authorization decision is made, so the logging is complete
 * rather than sprinkled across controllers where it would be complete for
 * whichever ones somebody remembered.
 *
 * Only AUTHENTICATED denials are recorded. An unauthenticated request
 * never reaches this guard, and a row with no tenant and no user would say
 * nothing anyway. The write is bounded by the rate limits in
 * common/security/throttle-policy.ts, so hammering a forbidden endpoint
 * cannot be used to inflate an append-only table.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionCode[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user: RequestUser | undefined = request.user;
    if (!user) throw new UnauthorizedException('Not authenticated');

    const granted = await this.prisma.withTenant(user.tenantId, (tx) => this.effectivePermissions.get(tx, user.id));

    if (!granted) throw new UnauthorizedException('User is not active');

    const missing = required.filter((code) => !granted.has(code));
    if (missing.length > 0) {
      // Written in its own transaction, and never allowed to turn a 403
      // into a 500: if the audit write fails the denial still stands, which
      // is the safe direction. The row names what was attempted and what
      // was missing, because "denied" without either is not evidence.
      try {
        await this.prisma.withTenant(user.tenantId, (tx) =>
          this.audit.record(tx, {
            businessId: user.tenantId,
            userId: user.id,
            action: 'PERMISSION_DENIED',
            entityType: 'Endpoint',
            entityId: `${request.method} ${request.route?.path ?? request.url}`,
            reason: `missing: ${missing.join(', ')}`,
            ipAddress: request.ip ?? null,
            userAgent: request.headers?.['user-agent'] ?? null,
            requestId: request.requestId ?? null,
          }),
        );
      } catch {
        // Deliberately swallowed. A failure to record must not tell the
        // caller anything, and must not let a denied request through.
      }
      throw new ForbiddenException(`Missing permission(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
