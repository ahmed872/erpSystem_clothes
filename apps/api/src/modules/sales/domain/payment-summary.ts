import { Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';

export type PaymentStatus = 'PAID' | 'PARTIALLY_PAID' | 'UNPAID';

export interface PaymentSummary {
  paidAmount: Prisma.Decimal;
  remainingAmount: Prisma.Decimal;
  paymentStatus: PaymentStatus;
}

/**
 * `paidAmount`/`remainingAmount`/`paymentStatus` are NEVER stored -
 * always derived from `SUM(SalePayment.amount)` against `Sale.totalAmount`,
 * computed on every read, mirroring the balance-by-SUM principle used
 * throughout Phases 4-5. Shared by GetSaleUseCase (single-sale detail)
 * and CreateSalePaymentUseCase's own overpayment guard, so the exact
 * same formula backs both the validation and what a client sees.
 */
export async function computePaymentSummary(tx: TenantTx, businessId: string, sale: { id: string; totalAmount: Prisma.Decimal }): Promise<PaymentSummary> {
  const result = await tx.salePayment.aggregate({
    where: { businessId, saleId: sale.id },
    _sum: { amount: true },
  });
  const paidAmount = result._sum.amount ?? new Prisma.Decimal(0);
  const remainingAmount = sale.totalAmount.minus(paidAmount);
  const paymentStatus: PaymentStatus = remainingAmount.lessThanOrEqualTo(0) ? 'PAID' : paidAmount.greaterThan(0) ? 'PARTIALLY_PAID' : 'UNPAID';
  return { paidAmount, remainingAmount, paymentStatus };
}
