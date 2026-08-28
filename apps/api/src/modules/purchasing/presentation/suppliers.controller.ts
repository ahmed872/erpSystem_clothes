import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createSupplierSchema,
  updateSupplierSchema,
  supplierListQuerySchema,
  CreateSupplierInput,
  UpdateSupplierInput,
  SupplierListQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CreateSupplierUseCase } from '../application/suppliers/create-supplier.use-case';
import { UpdateSupplierUseCase } from '../application/suppliers/update-supplier.use-case';
import { DeactivateSupplierUseCase } from '../application/suppliers/deactivate-supplier.use-case';
import { ListSuppliersUseCase } from '../application/suppliers/list-suppliers.use-case';
import { GetSupplierUseCase } from '../application/suppliers/get-supplier.use-case';

@Controller('purchasing/suppliers')
export class SuppliersController {
  constructor(
    private readonly createSupplier: CreateSupplierUseCase,
    private readonly updateSupplier: UpdateSupplierUseCase,
    private readonly deactivateSupplier: DeactivateSupplierUseCase,
    private readonly listSuppliers: ListSuppliersUseCase,
    private readonly getSupplier: GetSupplierUseCase,
  ) {}

  @RequirePermissions('suppliers.view')
  @Get()
  async list(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(supplierListQuerySchema)) query: SupplierListQuery) {
    return this.listSuppliers.execute(user, query);
  }

  @RequirePermissions('suppliers.create')
  @Post()
  async create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createSupplierSchema)) body: CreateSupplierInput) {
    return { data: await this.createSupplier.execute(user, body) };
  }

  @RequirePermissions('suppliers.view')
  @Get(':id')
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.getSupplier.execute(user, id) };
  }

  @RequirePermissions('suppliers.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateSupplierSchema)) body: UpdateSupplierInput,
  ) {
    return { data: await this.updateSupplier.execute(user, id, body) };
  }

  @RequirePermissions('suppliers.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deactivate(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.deactivateSupplier.execute(user, id) };
  }
}
