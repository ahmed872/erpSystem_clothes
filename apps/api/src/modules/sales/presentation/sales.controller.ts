import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  createSaleSchema,
  createSaleReturnSchema,
  createExchangeSchema,
  createSalePaymentSchema,
  saleListQuerySchema,
  CreateSaleInput,
  CreateSaleReturnInput,
  CreateExchangeInput,
  CreateSalePaymentInput,
  SaleListQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CreateSaleUseCase } from '../application/sales/create-sale.use-case';
import { GetSaleUseCase } from '../application/sales/get-sale.use-case';
import { ListSalesUseCase } from '../application/sales/list-sales.use-case';
import { CreateSaleReturnUseCase } from '../application/returns/create-sale-return.use-case';
import { CreateSalePaymentUseCase } from '../application/payments/create-sale-payment.use-case';
import { CreateExchangeUseCase } from '../application/exchanges/create-exchange.use-case';
import { GetSaleReceiptUseCase } from '../application/sales/get-sale-receipt.use-case';

@Controller('sales')
export class SalesController {
  constructor(
    private readonly createSale: CreateSaleUseCase,
    private readonly getSale: GetSaleUseCase,
    private readonly listSales: ListSalesUseCase,
    private readonly createReturn: CreateSaleReturnUseCase,
    private readonly createPayment: CreateSalePaymentUseCase,
    private readonly createExchange: CreateExchangeUseCase,
    private readonly saleReceipt: GetSaleReceiptUseCase,
  ) {}

  @RequirePermissions('sales.view')
  @Get()
  async list(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(saleListQuerySchema)) query: SaleListQuery) {
    return this.listSales.execute(user, query);
  }

  @RequirePermissions('sales.create')
  @Post()
  async create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createSaleSchema)) body: CreateSaleInput) {
    return { data: await this.createSale.execute(user, body) };
  }

  @RequirePermissions('sales.view')
  @Get(':id')
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.getSale.execute(user, id) };
  }

  /**
   * Phase 10 (10F): everything a printed receipt needs, in one request.
   * Gated on `sales.view` - whoever may look at the sale may reprint its
   * receipt. Cost and profit are absent from the payload for EVERYONE: a
   * receipt is a document handed to a customer.
   */
  @RequirePermissions('sales.view')
  @Get(':id/receipt')
  async receipt(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.saleReceipt.execute(user, id) };
  }

  @RequirePermissions('sales.return')
  @Post(':id/returns')
  async createSaleReturn(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createSaleReturnSchema)) body: CreateSaleReturnInput,
  ) {
    return { data: await this.createReturn.execute(user, id, body) };
  }

  /**
   * Phase 10 (Exchanges): goods back and goods out, as ONE event.
   *
   * Requires BOTH permissions. An exchange really is a return and a sale,
   * and someone trusted to do only one of them should not reach the pair
   * through a different door.
   */
  @RequirePermissions('sales.return', 'sales.create')
  @Post(':id/exchanges')
  async createSaleExchange(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createExchangeSchema)) body: CreateExchangeInput,
  ) {
    return { data: await this.createExchange.execute(user, id, body) };
  }

  @RequirePermissions('sales.pay')
  @Post(':id/payments')
  async pay(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createSalePaymentSchema)) body: CreateSalePaymentInput,
  ) {
    return { data: await this.createPayment.execute(user, id, body) };
  }
}
