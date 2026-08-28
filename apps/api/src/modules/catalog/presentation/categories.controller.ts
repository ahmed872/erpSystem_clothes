import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { createCategorySchema, updateCategorySchema, CreateCategoryInput, UpdateCategoryInput } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CategoriesService } from '../application/categories.service';

@Controller('catalog/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @RequirePermissions('categories.view')
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    return { data: await this.categories.list(user) };
  }

  @RequirePermissions('categories.create')
  @Post()
  async create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput,
  ) {
    return { data: await this.categories.create(user, body) };
  }

  @RequirePermissions('categories.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryInput,
  ) {
    return { data: await this.categories.update(user, id, body) };
  }
}
