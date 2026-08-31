import { Module } from '@nestjs/common';
import { CustomersController } from './presentation/customers.controller';
import { ShiftsController } from './presentation/shifts.controller';
import { SalesController } from './presentation/sales.controller';
import { CreateCustomerUseCase } from './application/customers/create-customer.use-case';
import { UpdateCustomerUseCase } from './application/customers/update-customer.use-case';
import { DeactivateCustomerUseCase } from './application/customers/deactivate-customer.use-case';
import { ListCustomersUseCase } from './application/customers/list-customers.use-case';
import { GetCustomerUseCase } from './application/customers/get-customer.use-case';
import { OpenShiftUseCase } from './application/shifts/open-shift.use-case';
import { CloseShiftUseCase } from './application/shifts/close-shift.use-case';
import { GetActiveShiftUseCase } from './application/shifts/get-active-shift.use-case';
import { ListShiftsUseCase } from './application/shifts/list-shifts.use-case';
import { ReconcileShiftUseCase } from './application/shifts/reconcile-shift.use-case';
import { ListPosWarehousesUseCase } from './application/shifts/list-pos-warehouses.use-case';
import { CreateSaleUseCase } from './application/sales/create-sale.use-case';
import { GetSaleUseCase } from './application/sales/get-sale.use-case';
import { ListSalesUseCase } from './application/sales/list-sales.use-case';
import { CreateSaleReturnUseCase } from './application/returns/create-sale-return.use-case';
import { CreateSalePaymentUseCase } from './application/payments/create-sale-payment.use-case';
import { CreateExchangeUseCase } from './application/exchanges/create-exchange.use-case';
import { HeldSalesService } from './application/holds/held-sales.service';
import { GetSaleReceiptUseCase } from './application/sales/get-sale-receipt.use-case';
import { HeldSalesController } from './presentation/held-sales.controller';
import { FinanceModule } from '../finance/finance.module';

@Module({
  // FinanceModule supplies CashMovementsService for the cash-movement
  // sub-resource that the shifts controller exposes (Phase 10, BD-17).
  imports: [FinanceModule],
  // HeldSalesController is declared BEFORE SalesController deliberately:
  // Nest matches routes in declaration order, and `sales/:id` would
  // otherwise swallow `sales/holds` and hand it to GetSaleUseCase.
  controllers: [CustomersController, ShiftsController, HeldSalesController, SalesController],
  providers: [
    CreateCustomerUseCase,
    UpdateCustomerUseCase,
    DeactivateCustomerUseCase,
    ListCustomersUseCase,
    GetCustomerUseCase,
    OpenShiftUseCase,
    CloseShiftUseCase,
    GetActiveShiftUseCase,
    ListShiftsUseCase,
    ReconcileShiftUseCase,
    ListPosWarehousesUseCase,
    CreateSaleUseCase,
    GetSaleUseCase,
    ListSalesUseCase,
    CreateSaleReturnUseCase,
    CreateSalePaymentUseCase,
    CreateExchangeUseCase,
    HeldSalesService,
    GetSaleReceiptUseCase,
  ],
})
export class SalesModule {}
