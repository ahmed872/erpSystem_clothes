import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createHeldSaleSchema,
  CreateHeldSaleInput,
  updateHeldSaleSchema,
  UpdateHeldSaleInput,
  resumeHeldSaleSchema,
  ResumeHeldSaleInput,
  voidHeldSaleSchema,
  VoidHeldSaleInput,
  heldSaleListQuerySchema,
  HeldSaleListQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { HeldSalesService } from '../application/holds/held-sales.service';

/**
 * Phase 10 (BLOCKING-2) — parked baskets.
 *
 * Under `/sales/holds` rather than a module of its own: a hold is a POS-
 * floor act, it belongs to the shift that took it, and the till that parks
 * a basket is the till that picks it up.
 */
@Controller('sales/holds')
export class HeldSalesController {
  constructor(private readonly holds: HeldSalesService) {}

  @RequirePermissions('sales.hold')
  @Get()
  async list(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(heldSaleListQuerySchema)) query: HeldSaleListQuery) {
    return this.holds.list(user, query);
  }

  @RequirePermissions('sales.hold')
  @Get(':id')
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.holds.get(user, id) };
  }

  @RequirePermissions('sales.hold')
  @Post()
  async create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createHeldSaleSchema)) body: CreateHeldSaleInput) {
    return { data: await this.holds.create(user, body) };
  }

  @RequirePermissions('sales.hold')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateHeldSaleSchema)) body: UpdateHeldSaleInput,
  ) {
    return { data: await this.holds.update(user, id, body) };
  }

  /**
   * Requires BOTH permissions. Resuming a basket really does create a
   * sale, and someone trusted only to park one should not reach the till
   * through a different door.
   */
  @RequirePermissions('sales.hold', 'sales.create')
  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  async resume(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(resumeHeldSaleSchema)) body: ResumeHeldSaleInput,
  ) {
    return { data: await this.holds.resume(user, id, body) };
  }

  @RequirePermissions('sales.hold')
  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  async void(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(voidHeldSaleSchema)) body: VoidHeldSaleInput,
  ) {
    return { data: await this.holds.void(user, id, body) };
  }
}
