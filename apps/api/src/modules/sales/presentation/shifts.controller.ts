import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { openShiftSchema, OpenShiftInput } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { OpenShiftUseCase } from '../application/shifts/open-shift.use-case';
import { CloseShiftUseCase } from '../application/shifts/close-shift.use-case';
import { GetActiveShiftUseCase } from '../application/shifts/get-active-shift.use-case';
import { ListShiftsUseCase } from '../application/shifts/list-shifts.use-case';

@Controller('sales/shifts')
export class ShiftsController {
  constructor(
    private readonly openShift: OpenShiftUseCase,
    private readonly closeShift: CloseShiftUseCase,
    private readonly getActiveShift: GetActiveShiftUseCase,
    private readonly listShifts: ListShiftsUseCase,
  ) {}

  @RequirePermissions('shifts.view')
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    return this.listShifts.execute(user);
  }

  @RequirePermissions('shifts.view')
  @Get('active')
  async active(@CurrentUser() user: RequestUser) {
    return { data: await this.getActiveShift.execute(user) };
  }

  @RequirePermissions('shifts.open')
  @Post('open')
  async open(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(openShiftSchema)) body: OpenShiftInput) {
    return { data: await this.openShift.execute(user, body) };
  }

  @RequirePermissions('shifts.close')
  @Post('close')
  @HttpCode(HttpStatus.OK)
  async close(@CurrentUser() user: RequestUser) {
    return { data: await this.closeShift.execute(user) };
  }
}
