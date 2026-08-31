import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { PermissionCode } from '@retail/shared-types';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Phase 12 BLOCKING-A. The frontend (ERP web + POS web) needs to know what
 * navigation, routes and actions to show for the CALLER it is actually
 * signed in as - without the global 117-code catalogue (`GET /permissions`,
 * gated on `permissions.view`, which most roles including Cashier do not
 * hold), and without recomputing authorization client-side.
 *
 * This returns exactly the identical computation `PermissionsGuard` uses to
 * decide every request - `EffectivePermissionsService`, the single place
 * "what can this user do right now" is computed - for the user identified
 * by the AUTHENTICATED JWT (`RequestUser`, set by `JwtAuthGuard` from the
 * verified access token). There is no user-id input anywhere on this path,
 * so a caller cannot ask for anyone's permissions but their own.
 *
 * Deliberately requires no permission of its own (see
 * `PermissionsController` - no `@RequirePermissions`), only a valid access
 * token: a user must always be able to learn what THEY can do, whatever
 * that set is, or a role with a sparse grant (e.g. Cashier) could never
 * drive a permission-aware UI at all.
 *
 * `EffectivePermissionsService.get` returns `null` for a user who no
 * longer exists or is not ACTIVE - the same signal `PermissionsGuard`
 * treats as "reject", so this endpoint rejects identically (401) rather
 * than answering "you have zero permissions", which would be a different
 * and misleading claim.
 *
 * This endpoint is NOT authorization. It answers "what would the guard
 * currently allow", read fresh on every call; it grants nothing by itself,
 * and every protected endpoint keeps re-checking its own required
 * permission(s) server-side exactly as before.
 */
@Injectable()
export class GetMyEffectivePermissionsUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser): Promise<PermissionCode[]> {
    const granted = await this.prisma.withTenant(actor.tenantId, (tx) =>
      this.effectivePermissions.get(tx, actor.id),
    );
    if (!granted) throw new UnauthorizedException('User is not active');
    return [...granted].sort() as PermissionCode[];
  }
}
