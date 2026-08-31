import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import {
  createTaxSchema,
  CreateTaxInput,
  updateTaxSchema,
  UpdateTaxInput,
  updateTaxSettingsSchema,
  UpdateTaxSettingsInput,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { TaxesService } from '../application/tax/taxes.service';

/**
 * Phase 10 (BD-18) — tax configuration.
 *
 * There is deliberately NO endpoint anywhere that applies a tax: resolution
 * and calculation happen server-side inside `CreateSaleUseCase`, so a
 * client can never supply the tax it would like to pay. This mirrors the
 * posture Phase 8D established for promotions.
 */
@Controller()
export class TaxesController {
  constructor(private readonly taxes: TaxesService) {}

  @RequirePermissions('tax.view')
  @Get('taxes')
  async list(@CurrentUser() user: RequestUser) {
    return { data: await this.taxes.list(user) };
  }

  @RequirePermissions('tax.manage')
  @Post('taxes')
  async create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createTaxSchema)) body: CreateTaxInput) {
    return { data: await this.taxes.create(user, body) };
  }

  @RequirePermissions('tax.manage')
  @Patch('taxes/:id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTaxSchema)) body: UpdateTaxInput,
  ) {
    return { data: await this.taxes.update(user, id, body) };
  }

  @RequirePermissions('tax.view')
  @Get('settings/tax')
  async getSettings(@CurrentUser() user: RequestUser) {
    return { data: await this.taxes.getSettings(user) };
  }

  @RequirePermissions('tax.manage')
  @Put('settings/tax')
  async updateSettings(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(updateTaxSettingsSchema)) body: UpdateTaxSettingsInput,
  ) {
    return { data: await this.taxes.updateSettings(user, body) };
  }
}
