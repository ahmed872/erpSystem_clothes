import { Module } from '@nestjs/common';
import { CashRegistersController } from './presentation/cash-registers.controller';
import { CashRegistersService } from './application/registers/cash-registers.service';
import { CashMovementsService } from './application/cash/cash-movements.service';
import { TaxesController } from './presentation/taxes.controller';
import { TaxesService } from './application/tax/taxes.service';
import { ExpensesController } from './presentation/expenses.controller';
import { ExpensesService } from './application/expenses/expenses.service';
import { AccountingEngineModule } from '../../engines/accounting/accounting-engine.module';

/**
 * Phase 10 (BD-17) — the finance module of the Phase 0 module map, opened
 * here with cash registers and the drawer ledger.
 *
 * It deliberately does NOT import InventoryEngineModule. Nothing in this
 * module changes stock, and keeping it out of the graph means a cash
 * register or an expense can never move inventory even by mistake -
 * structural rather than a convention.
 *
 * AccountingEngineModule IS imported, as of 10H: an expense posts a real
 * journal entry (Dr the category's account, Cr the tender), and it does so
 * through the one authority allowed to create entries. Cash registers and
 * shifts still post nothing themselves - the blind-close variance is
 * raised by `CloseShiftUseCase` in the sales module, which already owns the
 * shift.
 *
 * `CashMovementsService` is exported because the shifts controller (which
 * stays under `/sales/shifts`, see that controller's note) exposes the
 * cash-movement sub-resource.
 */
@Module({
  imports: [AccountingEngineModule],
  controllers: [CashRegistersController, TaxesController, ExpensesController],
  providers: [CashRegistersService, CashMovementsService, TaxesService, ExpensesService],
  exports: [CashMovementsService],
})
export class FinanceModule {}
