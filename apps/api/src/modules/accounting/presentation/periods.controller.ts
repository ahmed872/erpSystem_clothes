import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { openPeriodSchema, OpenPeriodInput } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { OpenPeriodUseCase } from '../application/periods/open-period.use-case';
import { ClosePeriodUseCase } from '../application/periods/close-period.use-case';
import { ReopenPeriodUseCase } from '../application/periods/reopen-period.use-case';
import { ListPeriodsUseCase } from '../application/periods/list-periods.use-case';

@Controller('accounting/periods')
export class PeriodsController {
  constructor(
    private readonly openPeriod: OpenPeriodUseCase,
    private readonly closePeriod: ClosePeriodUseCase,
    private readonly reopenPeriod: ReopenPeriodUseCase,
    private readonly listPeriods: ListPeriodsUseCase,
  ) {}

  @RequirePermissions('accounting.journal.view')
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    return this.listPeriods.execute(user);
  }

  @RequirePermissions('accounting.periods.manage')
  @Post()
  async open(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(openPeriodSchema)) body: OpenPeriodInput) {
    return { data: await this.openPeriod.execute(user, body) };
  }

  @RequirePermissions('accounting.periods.manage')
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  async close(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.closePeriod.execute(user, id) };
  }

  @RequirePermissions('accounting.reopen_period')
  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  async reopen(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.reopenPeriod.execute(user, id) };
  }
}
