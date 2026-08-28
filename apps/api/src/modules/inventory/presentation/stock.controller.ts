import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  recordOpeningStockSchema,
  receiveStockSchema,
  consumeStockSchema,
  adjustStockSchema,
  balanceQuerySchema,
  inventoryListQuerySchema,
  RecordOpeningStockInput,
  ReceiveStockInput,
  ConsumeStockInput,
  AdjustStockInput,
  BalanceQuery,
  InventoryListQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { RecordOpeningStockUseCase } from '../application/stock/opening-stock.use-case';
import { ReceiveStockUseCase } from '../application/stock/receive-stock.use-case';
import { ConsumeStockUseCase } from '../application/stock/consume-stock.use-case';
import { AdjustStockUseCase } from '../application/stock/adjust-stock.use-case';
import { GetBalancesUseCase } from '../application/stock/get-balances.use-case';
import { ListMovementsUseCase } from '../application/stock/list-movements.use-case';
import { ReconcileInventoryUseCase } from '../application/stock/reconcile-inventory.use-case';

@Controller('inventory')
export class StockController {
  constructor(
    private readonly openingStock: RecordOpeningStockUseCase,
    private readonly receiveStock: ReceiveStockUseCase,
    private readonly consumeStock: ConsumeStockUseCase,
    private readonly adjustStock: AdjustStockUseCase,
    private readonly getBalances: GetBalancesUseCase,
    private readonly listMovements: ListMovementsUseCase,
    private readonly reconcile: ReconcileInventoryUseCase,
  ) {}

  @RequirePermissions('inventory.opening_stock')
  @Post('opening-stock')
  async recordOpeningStock(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(recordOpeningStockSchema)) body: RecordOpeningStockInput,
  ) {
    return { data: await this.openingStock.execute(user, body) };
  }

  @RequirePermissions('inventory.receive')
  @Post('receipts')
  async receive(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(receiveStockSchema)) body: ReceiveStockInput) {
    return { data: await this.receiveStock.execute(user, body) };
  }

  @RequirePermissions('inventory.consume')
  @Post('consumptions')
  async consume(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(consumeStockSchema)) body: ConsumeStockInput) {
    return { data: await this.consumeStock.execute(user, body) };
  }

  @RequirePermissions('inventory.adjust')
  @Post('adjustments')
  async adjust(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(adjustStockSchema)) body: AdjustStockInput) {
    return { data: await this.adjustStock.execute(user, body) };
  }

  @RequirePermissions('inventory.view')
  @Get('balances')
  async balances(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(balanceQuerySchema)) query: BalanceQuery) {
    return { data: await this.getBalances.execute(user, query) };
  }

  @RequirePermissions('inventory.view')
  @Get('movements')
  async movements(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(inventoryListQuerySchema)) query: InventoryListQuery,
  ) {
    return this.listMovements.execute(user, query);
  }

  @RequirePermissions('inventory.view')
  @Get('reconciliation')
  async reconciliation(@CurrentUser() user: RequestUser, @Query('warehouseId') warehouseId?: string) {
    return { data: await this.reconcile.execute(user, warehouseId) };
  }
}
