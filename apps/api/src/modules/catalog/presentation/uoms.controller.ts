import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { createUomSchema, updateUomSchema, CreateUomInput, UpdateUomInput } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { UomsService } from '../application/uoms.service';

@Controller('catalog/uoms')
export class UomsController {
  constructor(private readonly uoms: UomsService) {}

  @RequirePermissions('uoms.view')
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    return { data: await this.uoms.list(user) };
  }

  @RequirePermissions('uoms.create')
  @Post()
  async create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createUomSchema)) body: CreateUomInput) {
    return { data: await this.uoms.create(user, body) };
  }

  @RequirePermissions('uoms.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateUomSchema)) body: UpdateUomInput,
  ) {
    return { data: await this.uoms.update(user, id, body) };
  }
}
