import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { ListPermissionsUseCase } from '../application/permissions/list-permissions.use-case';
import { GetMyEffectivePermissionsUseCase } from '../application/permissions/get-my-permissions.use-case';

@Controller('permissions')
export class PermissionsController {
  constructor(
    private readonly listPermissions: ListPermissionsUseCase,
    private readonly getMyPermissions: GetMyEffectivePermissionsUseCase,
  ) {}

  @RequirePermissions('permissions.view')
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    return { data: await this.listPermissions.execute(user) };
  }

  /**
   * Phase 12 BLOCKING-A. Deliberately declared BEFORE any `permissions.view`
   * check and with NO `@RequirePermissions` of its own - every authenticated
   * user may learn their own effective permissions, whatever that set is,
   * or a low-privilege role (Cashier, Sales Employee) could never drive a
   * permission-aware UI. Still requires a valid access token (JwtAuthGuard
   * runs ahead of PermissionsGuard for every route, gated or not) and is
   * scoped to the caller identified by that token - see
   * GetMyEffectivePermissionsUseCase for why this is safe and how it
   * differs from the global catalogue above.
   */
  @Get('me')
  async me(@CurrentUser() user: RequestUser) {
    return { data: { permissions: await this.getMyPermissions.execute(user) } };
  }
}
