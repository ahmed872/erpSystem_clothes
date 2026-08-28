import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  updateVariantSchema,
  changeVariantCostSchema,
  changeVariantPriceSchema,
  variantLookupQuerySchema,
  addBarcodeSchema,
  UpdateVariantInput,
  ChangeVariantCostInput,
  ChangeVariantPriceInput,
  VariantLookupQuery,
  AddBarcodeInput,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { VariantsService } from '../application/variants.service';
import { BarcodesService } from '../application/barcodes.service';

@Controller('catalog/variants')
export class VariantsController {
  constructor(
    private readonly variants: VariantsService,
    private readonly barcodes: BarcodesService,
  ) {}

  // Registered before ':id' so Nest's route matching doesn't treat
  // "lookup" as a variant id.
  @RequirePermissions('products.view')
  @Get('lookup')
  async lookup(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(variantLookupQuerySchema)) query: VariantLookupQuery) {
    return { data: await this.variants.lookupVariant(user, query) };
  }

  @RequirePermissions('products.view')
  @Get(':id')
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.variants.getVariant(user, id) };
  }

  @RequirePermissions('products.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateVariantSchema)) body: UpdateVariantInput,
  ) {
    return { data: await this.variants.updateVariant(user, id, body) };
  }

  @RequirePermissions('products.change_cost')
  @Patch(':id/cost')
  async changeCost(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(changeVariantCostSchema)) body: ChangeVariantCostInput,
  ) {
    return { data: await this.variants.changeCost(user, id, body) };
  }

  @RequirePermissions('products.change_price')
  @Patch(':id/price')
  async changePrice(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(changeVariantPriceSchema)) body: ChangeVariantPriceInput,
  ) {
    return { data: await this.variants.changePrice(user, id, body) };
  }

  @RequirePermissions('products.edit')
  @Post(':id/barcodes')
  async addBarcode(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addBarcodeSchema)) body: AddBarcodeInput,
  ) {
    return { data: await this.barcodes.add(user, id, body) };
  }
}
