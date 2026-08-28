import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createPurchaseSchema,
  updatePurchaseSchema,
  cancelPurchaseSchema,
  receivePurchaseSchema,
  createPurchaseReturnSchema,
  createPurchasePaymentSchema,
  purchaseListQuerySchema,
  CreatePurchaseInput,
  UpdatePurchaseInput,
  CancelPurchaseInput,
  ReceivePurchaseInput,
  CreatePurchaseReturnInput,
  CreatePurchasePaymentInput,
  PurchaseListQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CreatePurchaseUseCase } from '../application/purchases/create-purchase.use-case';
import { UpdatePurchaseUseCase } from '../application/purchases/update-purchase.use-case';
import { ApprovePurchaseUseCase } from '../application/purchases/approve-purchase.use-case';
import { CancelPurchaseUseCase } from '../application/purchases/cancel-purchase.use-case';
import { ListPurchasesUseCase } from '../application/purchases/list-purchases.use-case';
import { GetPurchaseUseCase } from '../application/purchases/get-purchase.use-case';
import { ReceivePurchaseUseCase } from '../application/receiving/receive-purchase.use-case';
import { CreatePurchaseReturnUseCase } from '../application/returns/create-purchase-return.use-case';
import { CreatePurchasePaymentUseCase } from '../application/payments/create-purchase-payment.use-case';

@Controller('purchasing/purchases')
export class PurchasesController {
  constructor(
    private readonly createPurchase: CreatePurchaseUseCase,
    private readonly updatePurchase: UpdatePurchaseUseCase,
    private readonly approvePurchase: ApprovePurchaseUseCase,
    private readonly cancelPurchase: CancelPurchaseUseCase,
    private readonly listPurchases: ListPurchasesUseCase,
    private readonly getPurchase: GetPurchaseUseCase,
    private readonly receivePurchase: ReceivePurchaseUseCase,
    private readonly createReturn: CreatePurchaseReturnUseCase,
    private readonly createPayment: CreatePurchasePaymentUseCase,
  ) {}

  @RequirePermissions('purchases.view')
  @Get()
  async list(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(purchaseListQuerySchema)) query: PurchaseListQuery) {
    return this.listPurchases.execute(user, query);
  }

  @RequirePermissions('purchases.create')
  @Post()
  async create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createPurchaseSchema)) body: CreatePurchaseInput) {
    return { data: await this.createPurchase.execute(user, body) };
  }

  @RequirePermissions('purchases.view')
  @Get(':id')
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.getPurchase.execute(user, id) };
  }

  @RequirePermissions('purchases.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePurchaseSchema)) body: UpdatePurchaseInput,
  ) {
    return { data: await this.updatePurchase.execute(user, id, body) };
  }

  @RequirePermissions('purchases.approve')
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.approvePurchase.execute(user, id) };
  }

  @RequirePermissions('purchases.cancel')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(cancelPurchaseSchema)) body: CancelPurchaseInput,
  ) {
    return { data: await this.cancelPurchase.execute(user, id, body) };
  }

  @RequirePermissions('purchases.receive')
  @Post(':id/receive')
  async receive(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(receivePurchaseSchema)) body: ReceivePurchaseInput,
  ) {
    return { data: await this.receivePurchase.execute(user, id, body) };
  }

  @RequirePermissions('purchases.return')
  @Post(':id/returns')
  async createPurchaseReturn(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createPurchaseReturnSchema)) body: CreatePurchaseReturnInput,
  ) {
    return { data: await this.createReturn.execute(user, id, body) };
  }

  @RequirePermissions('purchases.pay')
  @Post(':id/payments')
  async pay(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createPurchasePaymentSchema)) body: CreatePurchasePaymentInput,
  ) {
    return { data: await this.createPayment.execute(user, id, body) };
  }
}
