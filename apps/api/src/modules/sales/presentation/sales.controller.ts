import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  createSaleSchema,
  quoteSaleSchema,
  createSaleReturnSchema,
  previewSaleReturnSchema,
  createExchangeSchema,
  previewExchangeSchema,
  createSalePaymentSchema,
  saleListQuerySchema,
  serialLookupQuerySchema,
  SerialLookupQuery,
  CreateSaleInput,
  QuoteSaleInput,
  CreateSaleReturnInput,
  PreviewSaleReturnInput,
  CreateExchangeInput,
  PreviewExchangeInput,
  CreateSalePaymentInput,
  SaleListQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CreateSaleUseCase } from '../application/sales/create-sale.use-case';
import { QuoteSaleUseCase } from '../application/sales/quote-sale.use-case';
import { GetSaleUseCase } from '../application/sales/get-sale.use-case';
import { ListSalesUseCase } from '../application/sales/list-sales.use-case';
import { CreateSaleReturnUseCase } from '../application/returns/create-sale-return.use-case';
import { PreviewSaleReturnUseCase } from '../application/returns/preview-sale-return.use-case';
import { CreateSalePaymentUseCase } from '../application/payments/create-sale-payment.use-case';
import { CreateExchangeUseCase } from '../application/exchanges/create-exchange.use-case';
import { PreviewExchangeUseCase } from '../application/exchanges/preview-exchange.use-case';
import { LookupSerialUseCase } from '../application/sales/lookup-serial.use-case';
import { GetSaleReceiptUseCase } from '../application/sales/get-sale-receipt.use-case';

@Controller('sales')
export class SalesController {
  constructor(
    private readonly createSale: CreateSaleUseCase,
    private readonly quoteSale: QuoteSaleUseCase,
    private readonly getSale: GetSaleUseCase,
    private readonly listSales: ListSalesUseCase,
    private readonly createReturn: CreateSaleReturnUseCase,
    private readonly previewReturn: PreviewSaleReturnUseCase,
    private readonly createPayment: CreateSalePaymentUseCase,
    private readonly createExchange: CreateExchangeUseCase,
    private readonly previewExchange: PreviewExchangeUseCase,
    private readonly saleReceipt: GetSaleReceiptUseCase,
    private readonly lookupSerial: LookupSerialUseCase,
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

  /**
   * Phase 12 (Sale Quote): what this cart will cost, computed by the same
   * pipeline the sale itself runs, before any money is taken.
   *
   * POST rather than GET because the request is a cart - many lines, each
   * with serials and discounts - which does not belong in a query string.
   * It creates nothing: the whole handler runs in a READ ONLY transaction
   * (see QuoteSaleUseCase), so the database itself refuses a write from
   * this path.
   *
   * Gated on `sales.create`, not a new permission: quoting a sale is part
   * of making one, and anyone who may not sell has no use for the figure.
   * Deliberately NOT `sales.view` - reading past sales is a different act
   * from pricing a new one, and a Branch Manager (view + return, no
   * create) has no reason to reach this.
   */
  @RequirePermissions('sales.create')
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  async quote(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(quoteSaleSchema)) body: QuoteSaleInput) {
    return { data: await this.quoteSale.execute(user, body) };
  }

  /**
   * Phase 12 (D4). Registered before ':id' so Nest's route matching does
   * not treat "serial-lookup" as a sale id. Gated on `sales.view`, the
   * same permission the sale-number lookup this parallels uses - it
   * answers the same question by a different handle.
   */
  @RequirePermissions('sales.view')
  @Get('serial-lookup')
  async serialLookup(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(serialLookupQuerySchema)) query: SerialLookupQuery,
  ) {
    return { data: await this.lookupSerial.execute(user, query) };
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

  /**
   * Phase 12 (Returns): what this return is worth, before it happens.
   *
   * POST rather than GET because the request is a set of lines with
   * quantities, conditions and serials - not a query string. It creates
   * nothing: the handler runs in a READ ONLY transaction, so the database
   * itself refuses a write from this path (see PreviewSaleReturnUseCase).
   *
   * Gated on `sales.return`, the same permission the return itself needs -
   * not a new one, and not `sales.view`: knowing what a refund would be
   * worth is part of taking one.
   */
  @RequirePermissions('sales.return')
  @Post(':id/returns/preview')
  @HttpCode(HttpStatus.OK)
  async previewSaleReturn(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(previewSaleReturnSchema)) body: PreviewSaleReturnInput,
  ) {
    return { data: await this.previewReturn.execute(user, id, body) };
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
   * Phase 12 (Exchange preview) — the outcome, before the money moves.
   * See PreviewExchangeUseCase for what this does and does not compute.
   *
   * Requires BOTH permissions, exactly as the real exchange does: a
   * preview of an act neither role alone may perform is not a safe thing
   * to show.
   */
  @RequirePermissions('sales.return', 'sales.create')
  @Post(':id/exchanges/preview')
  @HttpCode(HttpStatus.OK)
  async previewSaleExchange(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(previewExchangeSchema)) body: PreviewExchangeInput,
  ) {
    return { data: await this.previewExchange.execute(user, id, body) };
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
