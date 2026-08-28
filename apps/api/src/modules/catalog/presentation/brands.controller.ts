import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { createBrandSchema, updateBrandSchema, CreateBrandInput, UpdateBrandInput } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { BrandsService } from '../application/brands.service';

@Controller('catalog/brands')
export class BrandsController {
  constructor(private readonly brands: BrandsService) {}

  @RequirePermissions('brands.view')
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    return { data: await this.brands.list(user) };
  }

  @RequirePermissions('brands.create')
  @Post()
  async create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createBrandSchema)) body: CreateBrandInput) {
    return { data: await this.brands.create(user, body) };
  }

  @RequirePermissions('brands.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateBrandSchema)) body: UpdateBrandInput,
  ) {
    return { data: await this.brands.update(user, id, body) };
  }
}
