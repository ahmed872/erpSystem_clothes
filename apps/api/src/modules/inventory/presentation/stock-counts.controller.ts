import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import {
  createStockCountSchema,
  submitStockCountItemsSchema,
  CreateStockCountInput,
  SubmitStockCountItemsInput,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CreateStockCountUseCase } from '../application/counts/create-stock-count.use-case';
import { SubmitStockCountItemsUseCase } from '../application/counts/submit-stock-count-items.use-case';
import { SubmitStockCountUseCase } from '../application/counts/submit-stock-count.use-case';
import { ApproveStockCountUseCase } from '../application/counts/approve-stock-count.use-case';
import { GetStockCountUseCase } from '../application/counts/get-stock-count.use-case';

@Controller('inventory/stock-counts')
export class StockCountsController {
  constructor(
    private readonly createStockCount: CreateStockCountUseCase,
    private readonly submitItems: SubmitStockCountItemsUseCase,
    private readonly submitCount: SubmitStockCountUseCase,
    private readonly approveCount: ApproveStockCountUseCase,
    private readonly getStockCount: GetStockCountUseCase,
  ) {}

  @RequirePermissions('inventory.stock_count_create')
  @Post()
  async create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createStockCountSchema)) body: CreateStockCountInput,
  ) {
    return { data: await this.createStockCount.execute(user, body) };
  }

  @RequirePermissions('inventory.view')
  @Get(':id')
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.getStockCount.execute(user, id) };
  }

  @RequirePermissions('inventory.stock_count_create')
  @Patch(':id/items')
  async submitItemsHandler(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(submitStockCountItemsSchema)) body: SubmitStockCountItemsInput,
  ) {
    return { data: await this.submitItems.execute(user, id, body) };
  }

  @RequirePermissions('inventory.stock_count_create')
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  async submit(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.submitCount.execute(user, id) };
  }

  @RequirePermissions('inventory.stock_count_approve')
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.approveCount.execute(user, id) };
  }
}
