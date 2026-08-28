import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import {
  createPriceListSchema,
  updatePriceListSchema,
  upsertPriceListEntrySchema,
  CreatePriceListInput,
  UpdatePriceListInput,
  UpsertPriceListEntryInput,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { PriceListsService } from '../application/price-lists.service';

@Controller('catalog/price-lists')
export class PriceListsController {
  constructor(private readonly priceLists: PriceListsService) {}

  @RequirePermissions('pricelists.view')
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    return { data: await this.priceLists.list(user) };
  }

  @RequirePermissions('pricelists.create')
  @Post()
  async create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createPriceListSchema)) body: CreatePriceListInput,
  ) {
    return { data: await this.priceLists.create(user, body) };
  }

  @RequirePermissions('pricelists.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePriceListSchema)) body: UpdatePriceListInput,
  ) {
    return { data: await this.priceLists.update(user, id, body) };
  }

  @RequirePermissions('pricelists.view')
  @Get(':id/prices')
  async listEntries(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.priceLists.listEntries(user, id) };
  }

  @RequirePermissions('pricelists.manage_prices')
  @Put(':id/prices')
  async upsertEntry(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(upsertPriceListEntrySchema)) body: UpsertPriceListEntryInput,
  ) {
    return { data: await this.priceLists.upsertEntry(user, id, body) };
  }
}
