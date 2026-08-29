import { Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';

export interface SaleCost {
  totalCost: Prisma.Decimal;
  grossProfit: Prisma.Decimal;
}

/**
 * COGS for a Sale, computed from the real StockMovement rows it
 * produced (SALE for simple variants, BUNDLE_CONSUMPTION for Bundle
 * components - both carry referenceType='Sale'/referenceId=sale.id,
 * see CreateSaleUseCase/consumeVariant) - never from current
 * Product/Variant cost fields, per the immutable unit_cost_at_movement
 * principle. grossProfit = (subtotal - discountAmount) - totalCost
 * (net revenue excluding tax, minus cost of goods sold). Only ever
 * computed for a caller holding `products.view_cost` - see the
 * omitFields calls in GetSaleUseCase/ListSalesUseCase.
 */
export async function computeSaleCost(tx: TenantTx, businessId: string, sale: { id: string; subtotal: Prisma.Decimal; discountAmount: Prisma.Decimal }): Promise<SaleCost> {
  const movements = await tx.stockMovement.findMany({
    where: { businessId, referenceType: 'Sale', referenceId: sale.id, movementType: { in: ['SALE', 'BUNDLE_CONSUMPTION'] } },
    select: { quantityBase: true, unitCostAtMovement: true },
  });
  const totalCost = movements.reduce(
    (sum, m) => sum.plus(m.quantityBase.abs().times(m.unitCostAtMovement)),
    new Prisma.Decimal(0),
  );
  const netRevenue = sale.subtotal.minus(sale.discountAmount);
  return { totalCost, grossProfit: netRevenue.minus(totalCost) };
}
