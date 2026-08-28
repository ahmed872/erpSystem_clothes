import { Module } from '@nestjs/common';
import { SuppliersController } from './presentation/suppliers.controller';
import { PurchasesController } from './presentation/purchases.controller';
import { CreateSupplierUseCase } from './application/suppliers/create-supplier.use-case';
import { UpdateSupplierUseCase } from './application/suppliers/update-supplier.use-case';
import { DeactivateSupplierUseCase } from './application/suppliers/deactivate-supplier.use-case';
import { ListSuppliersUseCase } from './application/suppliers/list-suppliers.use-case';
import { GetSupplierUseCase } from './application/suppliers/get-supplier.use-case';
import { CreatePurchaseUseCase } from './application/purchases/create-purchase.use-case';
import { UpdatePurchaseUseCase } from './application/purchases/update-purchase.use-case';
import { ApprovePurchaseUseCase } from './application/purchases/approve-purchase.use-case';
import { CancelPurchaseUseCase } from './application/purchases/cancel-purchase.use-case';
import { ListPurchasesUseCase } from './application/purchases/list-purchases.use-case';
import { GetPurchaseUseCase } from './application/purchases/get-purchase.use-case';
import { ReceivePurchaseUseCase } from './application/receiving/receive-purchase.use-case';
import { CreatePurchaseReturnUseCase } from './application/returns/create-purchase-return.use-case';
import { CreatePurchasePaymentUseCase } from './application/payments/create-purchase-payment.use-case';

@Module({
  controllers: [SuppliersController, PurchasesController],
  providers: [
    CreateSupplierUseCase,
    UpdateSupplierUseCase,
    DeactivateSupplierUseCase,
    ListSuppliersUseCase,
    GetSupplierUseCase,
    CreatePurchaseUseCase,
    UpdatePurchaseUseCase,
    ApprovePurchaseUseCase,
    CancelPurchaseUseCase,
    ListPurchasesUseCase,
    GetPurchaseUseCase,
    ReceivePurchaseUseCase,
    CreatePurchaseReturnUseCase,
    CreatePurchasePaymentUseCase,
  ],
})
export class PurchasingModule {}
