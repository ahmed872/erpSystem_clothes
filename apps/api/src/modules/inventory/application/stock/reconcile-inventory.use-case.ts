import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

interface LedgerRow {
  warehouse_id: string;
  variant_id: string;
  computed_quantity: string;
}

export interface ReconciliationDiscrepancy {
  warehouseId: string;
  variantId: string;
  cachedQuantityOnHand: string;
  computedFromLedger: string;
  difference: string;
}

/**
 * Independently recomputes every (warehouse, variant) quantity straight
 * from stock_movements (`SUM(quantity_base)`) and compares it against
 * the cached StockBalance row, per Phase 0 §56 and the Phase 3
 * requirement that the cache be independently verifiable against the
 * ledger at any time. Any difference is surfaced, never hidden - a
 * StockBalance can only ever legitimately diverge from this if a bug
 * exists somewhere (InventoryEngine always updates both in the same
 * transaction), so a non-empty result here is itself a data-integrity
 * alarm, not a routine report.
 */
@Injectable()
export class ReconcileInventoryUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, warehouseId?: string): Promise<{ checked: number; discrepancies: ReconciliationDiscrepancy[] }> {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const ledgerRows = warehouseId
        ? await tx.$queryRawUnsafe<LedgerRow[]>(
            `SELECT warehouse_id, variant_id, SUM(quantity_base) AS computed_quantity
             FROM stock_movements WHERE business_id = $1 AND warehouse_id = $2
             GROUP BY warehouse_id, variant_id`,
            actor.tenantId,
            warehouseId,
          )
        : await tx.$queryRawUnsafe<LedgerRow[]>(
            `SELECT warehouse_id, variant_id, SUM(quantity_base) AS computed_quantity
             FROM stock_movements WHERE business_id = $1
             GROUP BY warehouse_id, variant_id`,
            actor.tenantId,
          );

      const balances = await tx.stockBalance.findMany({
        where: { businessId: actor.tenantId, warehouseId: warehouseId ?? undefined },
        select: { warehouseId: true, variantId: true, quantityOnHand: true },
      });
      const balanceByKey = new Map(balances.map((b) => [`${b.warehouseId}:${b.variantId}`, b.quantityOnHand]));

      const discrepancies: ReconciliationDiscrepancy[] = [];
      const seenKeys = new Set<string>();

      for (const row of ledgerRows) {
        const key = `${row.warehouse_id}:${row.variant_id}`;
        seenKeys.add(key);
        const computed = new Prisma.Decimal(row.computed_quantity);
        const cached = balanceByKey.get(key) ?? new Prisma.Decimal(0);
        if (!computed.equals(cached)) {
          discrepancies.push({
            warehouseId: row.warehouse_id,
            variantId: row.variant_id,
            cachedQuantityOnHand: cached.toString(),
            computedFromLedger: computed.toString(),
            difference: cached.minus(computed).toString(),
          });
        }
      }

      // A balance row with movements summing to zero net but no ledger
      // rows at all would be caught above (SUM would just not appear -
      // Postgres GROUP BY only returns keys that have at least one row);
      // a balance row that exists with a nonzero cached quantity but NO
      // ledger rows at all is its own integrity violation (a balance
      // that was mutated without ever going through the engine).
      for (const b of balances) {
        const key = `${b.warehouseId}:${b.variantId}`;
        if (!seenKeys.has(key) && !b.quantityOnHand.isZero()) {
          discrepancies.push({
            warehouseId: b.warehouseId,
            variantId: b.variantId,
            cachedQuantityOnHand: b.quantityOnHand.toString(),
            computedFromLedger: '0',
            difference: b.quantityOnHand.toString(),
          });
        }
      }

      return { checked: ledgerRows.length, discrepancies };
    });
  }
}
