import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  createAttributeSchema,
  updateAttributeSchema,
  createAttributeValueSchema,
  updateAttributeValueSchema,
  CreateAttributeInput,
  UpdateAttributeInput,
  CreateAttributeValueInput,
  UpdateAttributeValueInput,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { AttributesService } from '../application/attributes.service';

@Controller('catalog')
export class AttributesController {
  constructor(private readonly attributes: AttributesService) {}

  @RequirePermissions('attributes.view')
  @Get('attributes')
  async list(@CurrentUser() user: RequestUser) {
    return { data: await this.attributes.listAttributes(user) };
  }

  @RequirePermissions('attributes.create')
  @Post('attributes')
  async create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createAttributeSchema)) body: CreateAttributeInput,
  ) {
    return { data: await this.attributes.createAttribute(user, body) };
  }

  @RequirePermissions('attributes.edit')
  @Patch('attributes/:id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAttributeSchema)) body: UpdateAttributeInput,
  ) {
    return { data: await this.attributes.updateAttribute(user, id, body) };
  }

  @RequirePermissions('attributes.create')
  @Post('attributes/:id/values')
  async createValue(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createAttributeValueSchema)) body: CreateAttributeValueInput,
  ) {
    return { data: await this.attributes.createValue(user, id, body) };
  }

  @RequirePermissions('attributes.edit')
  @Patch('attribute-values/:id')
  async updateValue(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAttributeValueSchema)) body: UpdateAttributeValueInput,
  ) {
    return { data: await this.attributes.updateValue(user, id, body) };
  }

  @RequirePermissions('attributes.delete')
  @Delete('attribute-values/:id')
  async deleteValue(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.attributes.deleteValue(user, id);
    return { data: null };
  }
}
