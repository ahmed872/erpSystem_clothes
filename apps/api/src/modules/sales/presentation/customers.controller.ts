import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createCustomerSchema,
  updateCustomerSchema,
  customerListQuerySchema,
  CreateCustomerInput,
  UpdateCustomerInput,
  CustomerListQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CreateCustomerUseCase } from '../application/customers/create-customer.use-case';
import { UpdateCustomerUseCase } from '../application/customers/update-customer.use-case';
import { DeactivateCustomerUseCase } from '../application/customers/deactivate-customer.use-case';
import { ListCustomersUseCase } from '../application/customers/list-customers.use-case';
import { GetCustomerUseCase } from '../application/customers/get-customer.use-case';

@Controller('sales/customers')
export class CustomersController {
  constructor(
    private readonly createCustomer: CreateCustomerUseCase,
    private readonly updateCustomer: UpdateCustomerUseCase,
    private readonly deactivateCustomer: DeactivateCustomerUseCase,
    private readonly listCustomers: ListCustomersUseCase,
    private readonly getCustomer: GetCustomerUseCase,
  ) {}

  @RequirePermissions('customers.view')
  @Get()
  async list(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(customerListQuerySchema)) query: CustomerListQuery) {
    return this.listCustomers.execute(user, query);
  }

  @RequirePermissions('customers.create')
  @Post()
  async create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createCustomerSchema)) body: CreateCustomerInput) {
    return { data: await this.createCustomer.execute(user, body) };
  }

  @RequirePermissions('customers.view')
  @Get(':id')
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.getCustomer.execute(user, id) };
  }

  @RequirePermissions('customers.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCustomerSchema)) body: UpdateCustomerInput,
  ) {
    return { data: await this.updateCustomer.execute(user, id, body) };
  }

  @RequirePermissions('customers.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deactivate(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.deactivateCustomer.execute(user, id) };
  }
}
