import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, StockMovementType } from '@prisma/client';
import { TenantTx } from '../../common/prisma/prisma.service';
import { InsufficientStockDomainError } from '../../common/errors/domain-error';
import { assertDocumentProvenance } from './document-provenance';

interface MovementBaseParams {
  businessId: string;
  branchId: string;
  warehouseId: string;
  variantId: string;
  movementType: StockMovementType;
  /**
   * Cost basis for an INCREASE movement (e.g. the purchase's unit cost).
   * Ignored for a decrease - COGS for a decrease always comes from the
   * ledger's current weighted-average cost, never a caller-supplied
   * value (Phase 0 §10: never compute profit from a client-asserted
   * cost). Defaults to the current average cost when omitted on an
   * increase (the "found stock" / no-new-cost-information case).
   */
  unitCostOverride?: Prisma.Decimal.Value;
  uomId?: string;
  quantityInUom?: Prisma.Decimal.Value;
  referenceType?: string;
  referenceId?: string;
  lotId?: string;
  reason?: string;
  createdBy?: string;
  /**
   * Resolved by the caller BEFORE invoking the engine (tenant Setting AND
   * actor permission both required - see resolveAllowNegative). The
   * engine itself has no opinion on authorization; it only enforces the
   * boolean it's given.
   */
  allowNegative: boolean;
}

export interface ApplyMovementParams extends MovementBaseParams {
  /** Signed, in the variant's base UOM. Positive = stock in, negative = stock out. */
  quantityDelta: Prisma.Decimal.Value;
}

export interface ApplyAbsoluteQuantityParams extends MovementBaseParams {
  /**
   * The exact quantity the balance should equal after this call (e.g. a
   * stock count's counted quantity). The engine locks the balance row
   * FIRST and computes `targetQuantity - <balance as of that lock>` -
   * never from a value read before the lock was acquired, which would
   * be stale if a concurrent transaction changed the balance in between
   * (exactly the bug this method exists to avoid - see
   * ApproveStockCountUseCase).
   */
  targetQuantity: Prisma.Decimal.Value;
}

export interface StockMovementSnapshot {
  id: string;
  quantityBase: Prisma.Decimal;
  unitCostAtMovement: Prisma.Decimal;
  isNegativeStock: boolean;
}

export interface ApplyMovementResult {
  movement: StockMovementSnapshot;
  quantityOnHand: Prisma.Decimal;
  averageCost: Prisma.Decimal;
}

/** Returned by applyAbsoluteQuantity when the target already equals the
 * locked current balance - no movement is created for a zero delta. */
export interface NoMovementResult {
  movement: null;
  quantityOnHand: Prisma.Decimal;
  averageCost: Prisma.Decimal;
}

interface BalanceRow {
  id: string;
  quantity_on_hand: string;
  average_cost: string;
}

/**
 * The single, shared core of every stock-affecting operation in the
 * system (opening stock, receipts, consumption, adjustments, transfers,
 * stock-count approvals, bundle consumption). Every other use-case in
 * this phase calls THIS instead of touching stock_movements/stock_balances
 * directly, so the locking + costing rules below are enforced exactly
 * once, not re-implemented per feature (Phase 3 instruction #12).
 *
 * StockMovement is the only source of truth (see schema.prisma module
 * comment). StockBalance is updated here purely as a cache, inside the
 * exact same DB transaction as the movement insert - if either write
 * fails, both roll back together.
 */
@Injectable()
export class InventoryEngineService {
  async applyMovement(tx: TenantTx, params: ApplyMovementParams): Promise<ApplyMovementResult> {
    // Phase 22 (P21-2). Checked BEFORE the balance is locked and before
    // stock availability, deliberately: a movement that cannot say where
    // it came from is malformed whatever the shelf holds, and a caller
    // who omits the reference should be told THAT rather than handed a
    // 409 about stock they were never going to be allowed to move.
    assertDocumentProvenance(params);

    const delta = new Prisma.Decimal(params.quantityDelta);
    if (delta.isZero()) {
      throw new Error('InventoryEngine.applyMovement: quantityDelta cannot be zero');
    }

    const balanceRow = await this.lockOrCreateBalance(tx, params.businessId, params.warehouseId, params.variantId);
    return this.applyLockedDelta(tx, balanceRow, delta, params);
  }

  /**
   * Locks first, computes the delta from the target AFTER locking, then
   * applies it. See ApplyAbsoluteQuantityParams for why this exists as
   * its own method rather than "peek the balance, compute a delta,
   * call applyMovement" in the caller - that sequence has a race window
   * this one closes by construction.
   */
  async applyAbsoluteQuantity(
    tx: TenantTx,
    params: ApplyAbsoluteQuantityParams,
  ): Promise<ApplyMovementResult | NoMovementResult> {
    // The same guard on the other public entry. In practice this path
    // writes ADJUSTMENT (stock-count approval), which is exempt — but the
    // check belongs on every door into the engine, not on the one that
    // happens to need it today.
    assertDocumentProvenance(params);

    const balanceRow = await this.lockOrCreateBalance(tx, params.businessId, params.warehouseId, params.variantId);
    const currentQty = new Prisma.Decimal(balanceRow.quantity_on_hand);
    const target = new Prisma.Decimal(params.targetQuantity);
    const delta = target.minus(currentQty);

    if (delta.isZero()) {
      return { movement: null, quantityOnHand: currentQty, averageCost: new Prisma.Decimal(balanceRow.average_cost) };
    }
    return this.applyLockedDelta(tx, balanceRow, delta, params);
  }

  /** Shared math + persistence, given a balance row ALREADY locked by the caller. */
  private async applyLockedDelta(
    tx: TenantTx,
    balanceRow: BalanceRow,
    delta: Prisma.Decimal,
    params: MovementBaseParams,
  ): Promise<ApplyMovementResult> {
    const currentQty = new Prisma.Decimal(balanceRow.quantity_on_hand);
    const currentAvgCost = new Prisma.Decimal(balanceRow.average_cost);
    const newQty = currentQty.plus(delta);

    let unitCostAtMovement: Prisma.Decimal;
    let newAvgCost: Prisma.Decimal;

    if (delta.isPositive()) {
      const inputCost =
        params.unitCostOverride !== undefined ? new Prisma.Decimal(params.unitCostOverride) : currentAvgCost;
      unitCostAtMovement = inputCost;

      if (newQty.lessThanOrEqualTo(0)) {
        // Still at/below zero after this increase (e.g. filling in part
        // of a negative balance) - nothing meaningful to weight against.
        newAvgCost = currentAvgCost;
      } else if (currentQty.lessThanOrEqualTo(0)) {
        // Crossing from at/below zero to positive: reset the cost basis
        // to this movement's cost rather than weighting against a
        // meaningless non-positive prior quantity.
        newAvgCost = inputCost;
      } else {
        newAvgCost = currentQty.times(currentAvgCost).plus(delta.times(inputCost)).dividedBy(newQty);
      }
    } else {
      // Decrease: COGS is always the current average cost, never a
      // caller-supplied value, and a decrease never changes the average
      // cost itself.
      unitCostAtMovement = currentAvgCost;
      newAvgCost = currentAvgCost;

      if (newQty.isNegative() && !params.allowNegative) {
        throw new InsufficientStockDomainError('Insufficient stock available for this operation', {
          warehouseId: params.warehouseId,
          variantId: params.variantId,
          available: currentQty.toString(),
          requested: delta.abs().toString(),
        });
      }
    }

    const isNegative = newQty.isNegative();

    const movement = await tx.stockMovement.create({
      data: {
        id: randomUUID(),
        businessId: params.businessId,
        branchId: params.branchId,
        warehouseId: params.warehouseId,
        variantId: params.variantId,
        movementType: params.movementType,
        quantityBase: delta,
        uomId: params.uomId,
        quantityInUom: params.quantityInUom === undefined ? undefined : new Prisma.Decimal(params.quantityInUom),
        unitCostAtMovement,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        lotId: params.lotId,
        isNegativeStock: isNegative,
        reason: params.reason,
        createdBy: params.createdBy,
      },
    });

    await tx.stockBalance.update({
      where: { id: balanceRow.id },
      data: { quantityOnHand: newQty, averageCost: newAvgCost },
    });

    return {
      movement: {
        id: movement.id,
        quantityBase: movement.quantityBase,
        unitCostAtMovement: movement.unitCostAtMovement,
        isNegativeStock: movement.isNegativeStock,
      },
      quantityOnHand: newQty,
      averageCost: newAvgCost,
    };
  }

  /**
   * Locks the StockBalance row for (warehouse, variant) with
   * `SELECT ... FOR UPDATE`, creating a zero-balance row first if none
   * exists yet. This is what makes two concurrent requests touching the
   * same (warehouse, variant) serialize: the second transaction's
   * `FOR UPDATE` blocks until the first commits or rolls back, so it
   * always sees the first one's already-applied change before deciding
   * whether there's enough stock left.
   */
  /**
   * Phase 10 (BLOCKING-2) — the ADVISORY reservation counter.
   *
   * Parking a basket raises it; resuming or voiding lowers it. It lives on
   * the engine because `stock_balances` is the engine's table and nothing
   * else may write it (non-negotiable #5) - not because a reservation is a
   * movement. IT IS NOT ONE, and this method deliberately writes NO
   * StockMovement: no goods went anywhere, and inventing a movement for an
   * intention would corrupt the one ledger every cost in the system is
   * derived from.
   *
   * NOTHING ENFORCES THIS NUMBER. `applyLockedDelta`'s insufficient-stock
   * check reads `quantity_on_hand` alone, so a parked basket can never
   * stop a real customer at the till from buying the goods in front of
   * them. That is precisely what makes the hold SOFT (the approved
   * resolution of BLOCKING-2); hard reservation is a separate, deferred
   * decision. What the counter buys is visibility - `availableQuantity =
   * quantityOnHand - quantityReserved` tells staff how much of the shelf
   * is already spoken for.
   *
   * The row is taken with the SAME `FOR UPDATE` lock every movement takes,
   * so a reservation and a sale of the same variant serialize rather than
   * racing. A release that would drive the counter below zero is refused
   * by the `stock_balances_quantity_reserved_nonneg` CHECK at the database
   * level, because "more released than was ever held" would make the
   * available figure wrong in the unsafe direction.
   */
  async adjustReservation(
    tx: TenantTx,
    params: { businessId: string; warehouseId: string; variantId: string; quantityDelta: Prisma.Decimal.Value },
  ): Promise<void> {
    const delta = new Prisma.Decimal(params.quantityDelta);
    if (delta.isZero()) return;

    const balance = await this.lockOrCreateBalance(tx, params.businessId, params.warehouseId, params.variantId);
    await tx.$executeRawUnsafe(
      `UPDATE stock_balances SET quantity_reserved = quantity_reserved + $2::numeric, updated_at = NOW() WHERE id = $1`,
      balance.id,
      delta.toString(),
    );
  }

  private async lockOrCreateBalance(
    tx: TenantTx,
    businessId: string,
    warehouseId: string,
    variantId: string,
  ): Promise<BalanceRow> {
    const select = () =>
      tx.$queryRawUnsafe<BalanceRow[]>(
        `SELECT id, quantity_on_hand, average_cost FROM stock_balances
         WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3
         FOR UPDATE`,
        businessId,
        warehouseId,
        variantId,
      );

    let rows = await select();
    if (rows.length === 0) {
      await tx.$executeRawUnsafe(
        `INSERT INTO stock_balances (id, business_id, warehouse_id, variant_id, quantity_on_hand, quantity_reserved, average_cost, updated_at)
         VALUES ($1, $2, $3, $4, 0, 0, 0, NOW())
         ON CONFLICT (business_id, warehouse_id, variant_id) DO NOTHING`,
        randomUUID(),
        businessId,
        warehouseId,
        variantId,
      );
      rows = await select();
    }
    return rows[0];
  }
}
