import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  createStockTransferSchema,
  receiveStockTransferSchema,
  CreateStockTransferInput,
  ReceiveStockTransferInput,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CreateStockTransferUseCase } from '../application/transfers/create-stock-transfer.use-case';
import { SendStockTransferUseCase } from '../application/transfers/send-stock-transfer.use-case';
import { ReceiveStockTransferUseCase } from '../application/transfers/receive-stock-transfer.use-case';
import { ListStockTransfersUseCase } from '../application/transfers/list-stock-transfers.use-case';
import { GetStockTransferUseCase } from '../application/transfers/get-stock-transfer.use-case';

@Controller('inventory/transfers')
export class TransfersController {
  constructor(
    private readonly createTransfer: CreateStockTransferUseCase,
    private readonly sendTransfer: SendStockTransferUseCase,
    private readonly receiveTransfer: ReceiveStockTransferUseCase,
    private readonly listTransfers: ListStockTransfersUseCase,
    private readonly getTransfer: GetStockTransferUseCase,
  ) {}

  @RequirePermissions('inventory.view')
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    return { data: await this.listTransfers.execute(user) };
  }

  @RequirePermissions('inventory.transfer_create')
  @Post()
  async create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createStockTransferSchema)) body: CreateStockTransferInput,
  ) {
    return { data: await this.createTransfer.execute(user, body) };
  }

  @RequirePermissions('inventory.view')
  @Get(':id')
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.getTransfer.execute(user, id) };
  }

  @RequirePermissions('inventory.transfer_send')
  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  async send(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.sendTransfer.execute(user, id) };
  }

  @RequirePermissions('inventory.transfer_receive')
  @Post(':id/receive')
  @HttpCode(HttpStatus.OK)
  async receive(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(receiveStockTransferSchema)) body: ReceiveStockTransferInput,
  ) {
    return { data: await this.receiveTransfer.execute(user, id, body) };
  }
}
