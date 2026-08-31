import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  openShiftSchema,
  OpenShiftInput,
  closeShiftSchema,
  CloseShiftInput,
  reconcileShiftSchema,
  ReconcileShiftInput,
  createCashMovementSchema,
  CreateCashMovementInput,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { OpenShiftUseCase } from '../application/shifts/open-shift.use-case';
import { CloseShiftUseCase } from '../application/shifts/close-shift.use-case';
import { ReconcileShiftUseCase } from '../application/shifts/reconcile-shift.use-case';
import { GetActiveShiftUseCase } from '../application/shifts/get-active-shift.use-case';
import { ListShiftsUseCase } from '../application/shifts/list-shifts.use-case';
import { CashMovementsService } from '../../finance/application/cash/cash-movements.service';

/**
 * Phase 10 keeps every shift-related route under the existing
 * `/sales/shifts` prefix that Phase 5 established, including the new cash
 * movement sub-resource. The Phase 0 module map places shifts under
 * `finance/`, and the cash *register* and *movement* code does live there —
 * but relocating the shift URLs would break a path clients already use for
 * no functional gain, so the routes stay put. Recorded in the release-gate
 * report as a deliberate, reported deviation rather than left implicit.
 */
@Controller('sales/shifts')
export class ShiftsController {
  constructor(
    private readonly openShift: OpenShiftUseCase,
    private readonly closeShift: CloseShiftUseCase,
    private readonly reconcileShift: ReconcileShiftUseCase,
    private readonly getActiveShift: GetActiveShiftUseCase,
    private readonly listShifts: ListShiftsUseCase,
    private readonly cashMovements: CashMovementsService,
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
  async close(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(closeShiftSchema)) body: CloseShiftInput) {
    return { data: await this.closeShift.execute(user, body) };
  }

  @RequirePermissions('shifts.reconcile')
  @Post(':id/reconcile')
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reconcileShiftSchema)) body: ReconcileShiftInput,
  ) {
    return { data: await this.reconcileShift.execute(user, id, body) };
  }

  @RequirePermissions('cash.movement')
  @Post(':id/cash-transactions')
  async recordCashMovement(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createCashMovementSchema)) body: CreateCashMovementInput,
  ) {
    return { data: await this.cashMovements.create(user, id, body) };
  }

  @RequirePermissions('shifts.view')
  @Get(':id/cash-transactions')
  async listCashMovements(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.cashMovements.list(user, id) };
  }
}
