import { describe, expect, it } from 'vitest';
import * as inventory from './inventory';
import {
  ADJUSTMENT_TYPES,
  balanceHasCost,
  canApproveCount,
  canEditCount,
  canReceiveTransfer,
  canSendTransfer,
  countTone,
  countVariance,
  hasReservation,
  isDepleted,
  isManualMovement,
  movementDirection,
  movementHasCost,
  movementTone,
  outstandingQuantity,
  serialIsAvailable,
  serialTone,
  transferTone,
} from './inventory';
import type { SerialStatus, StockMovementType } from './apiTypes';

/**
 * Phase 15.
 *
 * The first case is the point of the module and is asserted
 * mechanically: this file exports NO balance arithmetic. Stock is decided
 * by `InventoryEngineService` under a `SELECT ... FOR UPDATE`; a browser
 * that computed its own figure would be a second inventory engine, and it
 * would disagree with the real one exactly when it matters — under
 * concurrency.
 */

describe('the module boundary', () => {
  it('exports no stock calculator, and must never gain one', () => {
    for (const name of Object.keys(inventory)) {
      expect(name).not.toMatch(/^(compute|calculate|derive|predict)/i);
      expect(name).not.toMatch(/availableQuantity|newBalance|projected/i);
    }
  });

  it('states that reservations are read-only in this product', () => {
    // `quantityReserved` exists and is displayed, but NOTHING in the live
    // backend writes it: there are no reservation endpoints, and whether
    // held sales should reserve stock is an explicitly deferred owner
    // decision. Turning advisory into hard reservation is not this
    // milestone's to do.
    expect(inventory.RESERVATIONS_ARE_READ_ONLY).toBe(true);
    for (const name of Object.keys(inventory)) {
      expect(name).not.toMatch(/reserve[^d]|createReservation|releaseReservation/i);
    }
  });

  it('offers exactly the five adjustment reasons the schema accepts', () => {
    // `adjustStockSchema` enumerates these and refuses anything else, so
    // the dropdown cannot offer a sixth that must 422.
    expect(ADJUSTMENT_TYPES).toEqual(['ADJUSTMENT', 'DAMAGE', 'LOSS', 'INTERNAL_CONSUMPTION', 'EXPIRY']);
  });
});

describe('movementDirection', () => {
  it('reads the SIGN of the server figure, never the movement type', () => {
    // An ADJUSTMENT goes either way and only the figure knows which; a
    // SALES_RETURN adds while a SALE removes. Guessing from the type
    // would mislabel every correction.
    expect(movementDirection({ quantityBase: '5' })).toBe('IN');
    expect(movementDirection({ quantityBase: '-5' })).toBe('OUT');
    expect(movementDirection({ quantityBase: '0' })).toBe('NONE');
  });

  it('returns NONE rather than guessing on a non-numeric value', () => {
    expect(movementDirection({ quantityBase: '' })).toBe('NONE');
    expect(movementDirection({ quantityBase: 'n/a' })).toBe('NONE');
  });
});

describe('isManualMovement', () => {
  it('separates a deliberate act from a sale’s side effect', () => {
    // An unexplained −1 sitting next to a genuine sale is how stock
    // discrepancies get hidden.
    for (const t of ['ADJUSTMENT', 'DAMAGE', 'LOSS', 'INTERNAL_CONSUMPTION', 'EXPIRY', 'STOCK_COUNT', 'AUTHORIZED_CORRECTION'] as StockMovementType[]) {
      expect(isManualMovement(t)).toBe(true);
    }
    for (const t of ['SALE', 'PURCHASE', 'SALES_RETURN', 'TRANSFER_IN', 'TRANSFER_OUT', 'BUNDLE_CONSUMPTION', 'OPENING_BALANCE'] as StockMovementType[]) {
      expect(isManualMovement(t)).toBe(false);
    }
  });
});

describe('movementTone', () => {
  it('marks loss-shaped movements as danger and transfers as their own thing', () => {
    expect(movementTone('DAMAGE')).toBe('danger');
    expect(movementTone('LOSS')).toBe('danger');
    expect(movementTone('EXPIRY')).toBe('danger');
    expect(movementTone('ADJUSTMENT')).toBe('warning');
    expect(movementTone('TRANSFER_IN')).toBe('brand');
    expect(movementTone('SALE')).toBe('neutral');
  });
});

describe('cost visibility', () => {
  it('asks whether cost ARRIVED, never whether the user holds the grant', () => {
    // The server deletes the key — on mutation results as well as reads,
    // as of this milestone. A screen that asked about the permission
    // would be a branch someone could flip.
    expect(balanceHasCost({ averageCost: '400' })).toBe(true);
    expect(balanceHasCost({})).toBe(false);
    expect(movementHasCost({ unitCostAtMovement: '400' })).toBe(true);
    expect(movementHasCost({})).toBe(false);
  });

  it('treats a zero cost as present — 0 is a figure, not an absence', () => {
    expect(balanceHasCost({ averageCost: '0' })).toBe(true);
    expect(movementHasCost({ unitCostAtMovement: '0' })).toBe(true);
  });
});

describe('hasReservation / isDepleted', () => {
  it('reads the server’s reserved figure without recomputing available', () => {
    expect(hasReservation({ quantityReserved: '2' })).toBe(true);
    expect(hasReservation({ quantityReserved: '0' })).toBe(false);
    expect(hasReservation({ quantityReserved: 'x' })).toBe(false);
  });

  it('flags depletion from the SERVER’s availableQuantity, not from on-hand', () => {
    // available = onHand - reserved, computed server-side. A shelf with
    // stock that is entirely spoken for is depleted for selling purposes,
    // and only the server's figure knows that.
    expect(isDepleted({ availableQuantity: '0' })).toBe(true);
    expect(isDepleted({ availableQuantity: '-3' })).toBe(true);
    expect(isDepleted({ availableQuantity: '1' })).toBe(false);
  });
});

describe('transfer lifecycle', () => {
  it('offers each action only in the state the server would accept', () => {
    expect(canSendTransfer({ status: 'DRAFT' })).toBe(true);
    expect(canSendTransfer({ status: 'IN_TRANSIT' })).toBe(false);
    expect(canSendTransfer({ status: 'COMPLETED' })).toBe(false);

    expect(canReceiveTransfer({ status: 'IN_TRANSIT' })).toBe(true);
    expect(canReceiveTransfer({ status: 'DRAFT' })).toBe(false);
    expect(canReceiveTransfer({ status: 'COMPLETED' })).toBe(false);
  });

  it('never offers send and receive at the same time', () => {
    for (const status of ['DRAFT', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED'] as const) {
      expect(canSendTransfer({ status }) && canReceiveTransfer({ status })).toBe(false);
    }
  });

  it('tones the four states distinctly', () => {
    expect(transferTone('DRAFT')).toBe('neutral');
    expect(transferTone('IN_TRANSIT')).toBe('warning');
    expect(transferTone('COMPLETED')).toBe('success');
    expect(transferTone('CANCELLED')).toBe('danger');
  });
});

describe('outstandingQuantity', () => {
  it('names a short receipt from the server’s own two columns', () => {
    // The remainder stays IN_TRANSIT by the backend's rule rather than
    // being absorbed at either end. This surfaces it; it decides nothing.
    expect(outstandingQuantity({ quantity: '10', quantityReceived: '7' })).toBe(3);
    expect(outstandingQuantity({ quantity: '10', quantityReceived: '10' })).toBe(0);
  });

  it('treats an unreceived line as fully outstanding', () => {
    expect(outstandingQuantity({ quantity: '10', quantityReceived: null })).toBe(10);
  });

  it('returns 0 rather than NaN on a broken figure', () => {
    expect(outstandingQuantity({ quantity: 'x', quantityReceived: '1' })).toBe(0);
  });
});

describe('stock count lifecycle', () => {
  it('separates counting from APPROVING — two states and two grants', () => {
    // Approval is the call that actually moves stock, and a
    // BRANCH_MANAGER holds approve without create: they sign off a count
    // somebody else performed.
    expect(canEditCount({ status: 'DRAFT' })).toBe(true);
    expect(canEditCount({ status: 'SUBMITTED' })).toBe(false);
    expect(canApproveCount({ status: 'SUBMITTED' })).toBe(true);
    expect(canApproveCount({ status: 'DRAFT' })).toBe(false);
    expect(canApproveCount({ status: 'APPROVED' })).toBe(false);
  });

  it('never offers editing and approving at the same time', () => {
    for (const status of ['DRAFT', 'SUBMITTED', 'APPROVED', 'CANCELLED'] as const) {
      expect(canEditCount({ status }) && canApproveCount({ status })).toBe(false);
    }
  });

  it('tones the four states distinctly', () => {
    expect(countTone('DRAFT')).toBe('neutral');
    expect(countTone('SUBMITTED')).toBe('warning');
    expect(countTone('APPROVED')).toBe('success');
    expect(countTone('CANCELLED')).toBe('danger');
  });
});

describe('countVariance', () => {
  it('is actual minus expected, from the two figures the SERVER stored', () => {
    expect(countVariance({ expectedQuantity: '10', actualQuantity: '12' })).toBe(2);
    expect(countVariance({ expectedQuantity: '10', actualQuantity: '7' })).toBe(-3);
    expect(countVariance({ expectedQuantity: '10', actualQuantity: '10' })).toBe(0);
  });

  it('is NULL — not 0 — for a line nobody has counted yet', () => {
    // A 0 would read as "counted and matched", which is the opposite of
    // "not counted".
    expect(countVariance({ expectedQuantity: '10', actualQuantity: null })).toBeNull();
  });

  it('is null rather than NaN on a broken figure', () => {
    expect(countVariance({ expectedQuantity: 'x', actualQuantity: '1' })).toBeNull();
  });
});

describe('serials', () => {
  it('treats ONLY IN_STOCK as available, per the server’s status', () => {
    expect(serialIsAvailable('IN_STOCK')).toBe(true);
    for (const s of ['RESERVED', 'SOLD', 'DAMAGED', 'RETURNED', 'IN_TRANSIT', 'RETURNED_TO_SUPPLIER'] as SerialStatus[]) {
      expect(serialIsAvailable(s)).toBe(false);
    }
  });

  it('gives IN_TRANSIT its own tone — it is neither on a shelf nor a problem', () => {
    expect(serialTone('IN_TRANSIT')).toBe('brand');
    expect(serialTone('IN_STOCK')).toBe('success');
    expect(serialTone('DAMAGED')).toBe('danger');
    expect(serialTone('RETURNED_TO_SUPPLIER')).toBe('danger');
    // SOLD and RETURNED are ordinary history.
    expect(serialTone('SOLD')).toBe('neutral');
    expect(serialTone('RETURNED')).toBe('neutral');
  });

  it('covers every status the live enum defines', () => {
    const all: SerialStatus[] = ['IN_STOCK', 'RESERVED', 'SOLD', 'DAMAGED', 'RETURNED', 'IN_TRANSIT', 'RETURNED_TO_SUPPLIER'];
    for (const s of all) expect(typeof serialTone(s)).toBe('string');
  });
});
