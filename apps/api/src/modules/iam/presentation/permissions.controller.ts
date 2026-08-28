import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { ListPermissionsUseCase } from '../application/permissions/list-permissions.use-case';

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly listPermissions: ListPermissionsUseCase) {}

  @RequirePermissions('permissions.view')
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    return { data: await this.listPermissions.execute(user) };
  }
}
