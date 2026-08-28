import { Module } from '@nestjs/common';
import { StockController } from './presentation/stock.controller';
import { TransfersController } from './presentation/transfers.controller';
import { StockCountsController } from './presentation/stock-counts.controller';
import { LotsAndSerialsController } from './presentation/lots-and-serials.controller';
import { RecordOpeningStockUseCase } from './application/stock/opening-stock.use-case';
import { ReceiveStockUseCase } from './application/stock/receive-stock.use-case';
import { ConsumeStockUseCase } from './application/stock/consume-stock.use-case';
import { AdjustStockUseCase } from './application/stock/adjust-stock.use-case';
import { GetBalancesUseCase } from './application/stock/get-balances.use-case';
import { ListMovementsUseCase } from './application/stock/list-movements.use-case';
import { ReconcileInventoryUseCase } from './application/stock/reconcile-inventory.use-case';
import { ListLotsUseCase } from './application/stock/list-lots.use-case';
import { ListSerialsUseCase } from './application/stock/list-serials.use-case';
import { CreateStockTransferUseCase } from './application/transfers/create-stock-transfer.use-case';
import { SendStockTransferUseCase } from './application/transfers/send-stock-transfer.use-case';
import { ReceiveStockTransferUseCase } from './application/transfers/receive-stock-transfer.use-case';
import { ListStockTransfersUseCase } from './application/transfers/list-stock-transfers.use-case';
import { GetStockTransferUseCase } from './application/transfers/get-stock-transfer.use-case';
import { CreateStockCountUseCase } from './application/counts/create-stock-count.use-case';
import { SubmitStockCountItemsUseCase } from './application/counts/submit-stock-count-items.use-case';
import { SubmitStockCountUseCase } from './application/counts/submit-stock-count.use-case';
import { ApproveStockCountUseCase } from './application/counts/approve-stock-count.use-case';
import { GetStockCountUseCase } from './application/counts/get-stock-count.use-case';

@Module({
  controllers: [StockController, TransfersController, StockCountsController, LotsAndSerialsController],
  providers: [
    RecordOpeningStockUseCase,
    ReceiveStockUseCase,
    ConsumeStockUseCase,
    AdjustStockUseCase,
    GetBalancesUseCase,
    ListMovementsUseCase,
    ReconcileInventoryUseCase,
    ListLotsUseCase,
    ListSerialsUseCase,
    CreateStockTransferUseCase,
    SendStockTransferUseCase,
    ReceiveStockTransferUseCase,
    ListStockTransfersUseCase,
    GetStockTransferUseCase,
    CreateStockCountUseCase,
    SubmitStockCountItemsUseCase,
    SubmitStockCountUseCase,
    ApproveStockCountUseCase,
    GetStockCountUseCase,
  ],
})
export class InventoryModule {}
