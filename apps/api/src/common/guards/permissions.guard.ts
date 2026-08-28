import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionCode } from '@retail/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { EffectivePermissionsService } from '../authorization/effective-permissions.service';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { RequestUser } from '../decorators/current-user.decorator';

/**
 * Server-side authorization. Always re-reads the caller's effective
 * permission set (via EffectivePermissionsService) on every request
 * rather than trusting a snapshot embedded in the JWT, so revoking a
 * role/permission takes effect immediately rather than waiting for the
 * access token to expire. The frontend hiding a button is never a
 * substitute for this check (docs/architecture/PHASE-0-ARCHITECTURE.md
 * §9/§14).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
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
      throw new ForbiddenException(`Missing permission(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
