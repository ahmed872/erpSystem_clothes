import { Controller, Get, Query } from '@nestjs/common';
import { SerialNumberStatus } from '@prisma/client';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { ListLotsUseCase } from '../application/stock/list-lots.use-case';
import { ListSerialsUseCase } from '../application/stock/list-serials.use-case';

@Controller('inventory')
export class LotsAndSerialsController {
  constructor(
    private readonly listLots: ListLotsUseCase,
    private readonly listSerials: ListSerialsUseCase,
  ) {}

  @RequirePermissions('inventory.view')
  @Get('lots')
  async lots(@CurrentUser() user: RequestUser, @Query('variantId') variantId?: string) {
    return { data: await this.listLots.execute(user, variantId) };
  }

  @RequirePermissions('inventory.view')
  @Get('serials')
  async serials(
    @CurrentUser() user: RequestUser,
    @Query('variantId') variantId?: string,
    @Query('status') status?: SerialNumberStatus,
  ) {
    return { data: await this.listSerials.execute(user, variantId, status) };
  }
}
