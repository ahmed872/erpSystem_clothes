import type {
  AdjustmentType,
  SerialStatus,
  StockBalance,
  StockCount,
  StockMovement,
  StockMovementType,
  StockTransfer,
  TransferStatus,
} from './apiTypes';

/**
 * Phase 15 — the only inventory logic in the ERP browser, and it computes
 * no quantity.
 *
 * THERE IS NO BALANCE ARITHMETIC HERE AND THERE MUST NEVER BE ANY, for
 * the same reason `lib/priceLists.ts` has no price resolver and
 * `lib/shiftReview.ts` has no `expectedCash()`. Stock is decided by
 * `InventoryEngineService` under a `SELECT ... FOR UPDATE` on the balance
 * row; `availableQuantity` is computed server-side; a mutation's
 * resulting `quantityOnHand` comes back from the engine. A browser that
 * added or subtracted its own figure would be a second inventory engine,
 * free to disagree with the one that actually writes — and it would
 * disagree exactly when it matters, under concurrency.
 */

/**
 * RESERVATIONS ARE READ-ONLY IN THIS PRODUCT, and this states it once
 * rather than leaving each screen to discover it.
 *
 * `StockBalance.quantityReserved` exists and is displayed, but NOTHING in
 * the live backend writes it: there are no reservation endpoints, and
 * whether held sales should reserve stock is an explicitly deferred
 * owner decision. So the ERP shows the column and offers no control that
 * would change it. Turning the advisory concept into a hard reservation
 * is not this milestone's to do.
 */
export const RESERVATIONS_ARE_READ_ONLY = true;

/** The five signed adjustment reasons `adjustStockSchema` accepts. */
export const ADJUSTMENT_TYPES: AdjustmentType[] = ['ADJUSTMENT', 'DAMAGE', 'LOSS', 'INTERNAL_CONSUMPTION', 'EXPIRY'];

/**
 * Whether a movement ADDED stock or removed it, read from the sign of the
 * server's own signed `quantityBase`. Never inferred from the movement
 * type: a SALES_RETURN adds and a SALE removes, but an ADJUSTMENT does
 * either, and only the figure knows which.
 */
export type MovementDirection = 'IN' | 'OUT' | 'NONE';

export function movementDirection(movement: Pick<StockMovement, 'quantityBase'>): MovementDirection {
  const n = Number(movement.quantityBase);
  if (!Number.isFinite(n)) return 'NONE';
  if (n > 0) return 'IN';
  if (n < 0) return 'OUT';
  return 'NONE';
}

/**
 * Whether a movement is one a human performed deliberately, as opposed to
 * one a sale or transfer produced as a side effect.
 *
 * The adjustment screen must read as a different act from a sale, and the
 * movement list has to say which is which — an unexplained −1 next to a
 * genuine sale is how stock discrepancies get hidden.
 */
export function isManualMovement(type: StockMovementType): boolean {
  return (ADJUSTMENT_TYPES as StockMovementType[]).includes(type) || type === 'STOCK_COUNT' || type === 'AUTHORIZED_CORRECTION';
}

export function movementTone(type: StockMovementType): 'success' | 'warning' | 'danger' | 'neutral' | 'brand' {
  if (type === 'DAMAGE' || type === 'LOSS' || type === 'EXPIRY') return 'danger';
  if (isManualMovement(type)) return 'warning';
  if (type === 'TRANSFER_IN' || type === 'TRANSFER_OUT') return 'brand';
  return 'neutral';
}

/** Whether the caller was sent cost on this balance at all. Asked instead
 *  of "does the user hold the grant", so no client-side branch could be
 *  flipped to reveal a figure the response never carried. */
export function balanceHasCost(balance: Pick<StockBalance, 'averageCost'>): boolean {
  return balance.averageCost !== undefined;
}

export function movementHasCost(movement: Pick<StockMovement, 'unitCostAtMovement'>): boolean {
  return movement.unitCostAtMovement !== undefined;
}

/**
 * Whether any of this shelf is spoken for. Reads the server's figure; it
 * does not compute `availableQuantity`, which the server already sent.
 */
export function hasReservation(balance: Pick<StockBalance, 'quantityReserved'>): boolean {
  const n = Number(balance.quantityReserved);
  return Number.isFinite(n) && n > 0;
}

/** Stock at or below zero, which a manager wants to see first. */
export function isDepleted(balance: Pick<StockBalance, 'availableQuantity'>): boolean {
  const n = Number(balance.availableQuantity);
  return Number.isFinite(n) && n <= 0;
}

// ------------------------------------------------------- transfers -------
/**
 * The transfer lifecycle, mirrored so the UI offers only the action the
 * server would accept. Each of these is a separate GRANT as well as a
 * separate state, which is why they are separate controls.
 */
export function canSendTransfer(transfer: Pick<StockTransfer, 'status'>): boolean {
  return transfer.status === 'DRAFT';
}

export function canReceiveTransfer(transfer: Pick<StockTransfer, 'status'>): boolean {
  return transfer.status === 'IN_TRANSIT';
}

export function transferTone(status: TransferStatus): 'neutral' | 'warning' | 'success' | 'danger' {
  if (status === 'DRAFT') return 'neutral';
  if (status === 'IN_TRANSIT') return 'warning';
  if (status === 'COMPLETED') return 'success';
  return 'danger';
}

/**
 * Units shipped that did not arrive — shrinkage or damage in transit.
 *
 * This is NOT a stock calculation: both figures are the server's own
 * columns on the transfer item. The backend's rule, verified rather than
 * assumed: receiving is a single all-items call, the transfer moves to
 * COMPLETED whether or not everything arrived, and a `quantityReceived`
 * below `quantity` is REPORTED as a discrepancy rather than silently
 * corrected — the destination is credited only with what was actually
 * received, so the difference is a genuine loss, not a rounding.
 *
 * (The separate "stays IN_TRANSIT" rule applies to SERIALS: a tracked
 * unit that was shipped but not listed on the receipt keeps IN_TRANSIT
 * status rather than being placed in either warehouse. That is the serial
 * record's business, not this figure's.)
 *
 * The screen names the discrepancy; it decides nothing about it.
 */
export function outstandingQuantity(item: { quantity: string; quantityReceived: string | null }): number {
  const sent = Number(item.quantity);
  const received = Number(item.quantityReceived ?? 0);
  if (!Number.isFinite(sent) || !Number.isFinite(received)) return 0;
  return sent - received;
}

// ----------------------------------------------------- stock counts ------
export function canEditCount(count: Pick<StockCount, 'status'>): boolean {
  return count.status === 'DRAFT';
}

export function canSubmitCount(count: Pick<StockCount, 'status'>): boolean {
  return count.status === 'DRAFT';
}

/** Approval is a SECOND grant AND a second state — it is the call that
 *  actually moves stock to match what was counted. */
export function canApproveCount(count: Pick<StockCount, 'status'>): boolean {
  return count.status === 'SUBMITTED';
}

export function countTone(status: StockCount['status']): 'neutral' | 'warning' | 'success' | 'danger' {
  if (status === 'DRAFT') return 'neutral';
  if (status === 'SUBMITTED') return 'warning';
  if (status === 'APPROVED') return 'success';
  return 'danger';
}

/**
 * The difference a counted line will correct, from the two figures the
 * SERVER stored on it: `expectedQuantity` was snapshotted when the count
 * was created, `actualQuantity` is what the counter submitted. Null until
 * a line has actually been counted — never rendered as a 0, which would
 * read as "counted and matched".
 */
export function countVariance(item: { expectedQuantity: string; actualQuantity: string | null }): number | null {
  if (item.actualQuantity === null) return null;
  const expected = Number(item.expectedQuantity);
  const actual = Number(item.actualQuantity);
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return null;
  return actual - expected;
}

// ---------------------------------------------------------- serials ------
/** Whether a unit is on a shelf and sellable, per the SERVER's status. */
export function serialIsAvailable(status: SerialStatus): boolean {
  return status === 'IN_STOCK';
}

export function serialTone(status: SerialStatus): 'success' | 'warning' | 'danger' | 'neutral' | 'brand' {
  switch (status) {
    case 'IN_STOCK':
      return 'success';
    case 'IN_TRANSIT':
      return 'brand';
    case 'RESERVED':
      return 'warning';
    case 'DAMAGED':
    case 'RETURNED_TO_SUPPLIER':
      return 'danger';
    default:
      // SOLD and RETURNED are ordinary history, not problems.
      return 'neutral';
  }
}
