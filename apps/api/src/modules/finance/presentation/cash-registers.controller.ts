import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createCashRegisterSchema,
  CreateCashRegisterInput,
  updateCashRegisterSchema,
  UpdateCashRegisterInput,
  listCashRegistersQuerySchema,
  ListCashRegistersQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CashRegistersService } from '../application/registers/cash-registers.service';

/**
 * Phase 10 (BD-17) — cash register configuration.
 *
 * `cash_registers.view` is granted broadly, including to Cashiers and Sales
 * Employees, because choosing which till you are taking over is the first
 * step of opening a shift. `cash_registers.manage` is not: defining the
 * physical estate of a branch is an owner/branch-manager act.
 */
@Controller('cash-registers')
export class CashRegistersController {
  constructor(private readonly registers: CashRegistersService) {}

  @RequirePermissions('cash_registers.view')
  @Get()
  async list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(listCashRegistersQuerySchema)) query: ListCashRegistersQuery,
  ) {
    return { data: await this.registers.list(user, query) };
  }

  @RequirePermissions('cash_registers.manage')
  @Post()
  async create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createCashRegisterSchema)) body: CreateCashRegisterInput,
  ) {
    return { data: await this.registers.create(user, body) };
  }

  @RequirePermissions('cash_registers.manage')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCashRegisterSchema)) body: UpdateCashRegisterInput,
  ) {
    return { data: await this.registers.update(user, id, body) };
  }
}
