import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createWarehouseSchema,
  updateWarehouseSchema,
  CreateWarehouseInput,
  UpdateWarehouseInput,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CreateWarehouseUseCase } from '../application/warehouses/create-warehouse.use-case';
import { ListWarehousesUseCase } from '../application/warehouses/list-warehouses.use-case';
import { UpdateWarehouseUseCase } from '../application/warehouses/update-warehouse.use-case';

@Controller('warehouses')
export class WarehousesController {
  constructor(
    private readonly createWarehouse: CreateWarehouseUseCase,
    private readonly listWarehouses: ListWarehousesUseCase,
    private readonly updateWarehouse: UpdateWarehouseUseCase,
  ) {}

  @RequirePermissions('warehouses.view')
  @Get()
  async list(@CurrentUser() user: RequestUser, @Query('branchId') branchId?: string) {
    return { data: await this.listWarehouses.execute(user, branchId) };
  }

  @RequirePermissions('warehouses.create')
  @Post()
  async create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createWarehouseSchema)) body: CreateWarehouseInput,
  ) {
    return { data: await this.createWarehouse.execute(user, body) };
  }

  @RequirePermissions('warehouses.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateWarehouseSchema)) body: UpdateWarehouseInput,
  ) {
    return { data: await this.updateWarehouse.execute(user, id, body) };
  }
}
