import { Module } from '@nestjs/common';
import { CashRegistersController } from './presentation/cash-registers.controller';
import { CashRegistersService } from './application/registers/cash-registers.service';
import { CashMovementsService } from './application/cash/cash-movements.service';

/**
 * Phase 10 (BD-17) — the finance module of the Phase 0 module map, opened
 * here with cash registers and the drawer ledger.
 *
 * It deliberately imports neither InventoryEngineModule nor
 * AccountingEngineModule. Moving cash changes no stock, and the one
 * financial posting this area produces — the blind-close variance — is
 * raised by `CloseShiftUseCase` in the sales module, which already owns the
 * shift and already holds the AccountingEngine. Keeping this module engine
 * free means a cash register can never post a journal entry or move
 * inventory even by mistake: the module graph makes it structural rather
 * than a convention.
 *
 * `CashMovementsService` is exported because the shifts controller (which
 * stays under `/sales/shifts`, see that controller's note) exposes the
 * cash-movement sub-resource.
 */
@Module({
  controllers: [CashRegistersController],
  providers: [CashRegistersService, CashMovementsService],
  exports: [CashMovementsService],
})
export class FinanceModule {}
