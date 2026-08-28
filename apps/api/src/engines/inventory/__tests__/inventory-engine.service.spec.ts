import { Prisma } from '@prisma/client';
import { InventoryEngineService } from '../inventory-engine.service';
import { InsufficientStockDomainError } from '../../../common/errors/domain-error';

/**
 * Exercises the Weighted Average Cost math and negative-stock guard in
 * isolation, with a hand-rolled fake `tx` that behaves like a single
 * StockBalance row backed by real Prisma.Decimal arithmetic - no real
 * database, but real decimal math (the same library Prisma uses), so a
 * formula bug here would be caught the same way it would against
 * Postgres NUMERIC. Full transactional/locking/concurrency behavior is
 * covered separately by the e2e suite against real PostgreSQL.
 */
describe('InventoryEngineService (WAC math, unit)', () => {
  function makeFakeTx(initial: { quantityOnHand: string; averageCost: string }) {
    const state = { id: 'balance-1', quantity_on_hand: initial.quantityOnHand, average_cost: initial.averageCost };
    const movements: unknown[] = [];

    const tx = {
      $queryRawUnsafe: jest.fn(async () => [{ ...state }]),
      $executeRawUnsafe: jest.fn(async () => 1),
      stockMovement: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          movements.push(data);
          return { ...data, id: (data.id as string | undefined) ?? 'movement-1' };
        }),
      },
      stockBalance: {
        update: jest.fn(async ({ data }: { data: { quantityOnHand: Prisma.Decimal; averageCost: Prisma.Decimal } }) => {
          state.quantity_on_hand = data.quantityOnHand.toString();
          state.average_cost = data.averageCost.toString();
          return { ...state };
        }),
      },
    };
    return { tx: tx as never, state, movements };
  }

  const baseParams = {
    businessId: 'biz-1',
    branchId: 'branch-1',
    warehouseId: 'wh-1',
    variantId: 'variant-1',
    createdBy: 'user-1',
  };

  it('first-ever increase sets the average cost to the input cost directly', async () => {
    const engine = new InventoryEngineService();
    const { tx } = makeFakeTx({ quantityOnHand: '0', averageCost: '0' });

    const result = await engine.applyMovement(tx, {
      ...baseParams,
      quantityDelta: 100,
      movementType: 'PURCHASE',
      unitCostOverride: 10,
      allowNegative: false,
    });

    expect(result.quantityOnHand.toString()).toBe('100');
    expect(result.averageCost.toString()).toBe('10');
    expect(result.movement.unitCostAtMovement.toString()).toBe('10');
  });

  it('a second purchase at a different cost blends into the correct weighted average', async () => {
    const engine = new InventoryEngineService();
    // 100 units already on hand @ $10 = $1000 total value.
    const { tx } = makeFakeTx({ quantityOnHand: '100', averageCost: '10' });

    // Buy 50 more @ $16 = $800. New total: 150 units, $1800 -> $12/unit.
    const result = await engine.applyMovement(tx, {
      ...baseParams,
      quantityDelta: 50,
      movementType: 'PURCHASE',
      unitCostOverride: 16,
      allowNegative: false,
    });

    expect(result.quantityOnHand.toString()).toBe('150');
    expect(result.averageCost.toString()).toBe('12');
  });

  it('a decrease (sale) locks in the CURRENT average cost as COGS and never changes the average cost', async () => {
    const engine = new InventoryEngineService();
    const { tx } = makeFakeTx({ quantityOnHand: '150', averageCost: '12' });

    const result = await engine.applyMovement(tx, {
      ...baseParams,
      quantityDelta: -30,
      movementType: 'SALE',
      // unitCostOverride is deliberately omitted AND would be ignored even
      // if given - COGS always comes from the ledger's current average.
      allowNegative: false,
    });

    expect(result.quantityOnHand.toString()).toBe('120');
    expect(result.averageCost.toString()).toBe('12'); // unchanged
    expect(result.movement.unitCostAtMovement.toString()).toBe('12'); // this sale's COGS/unit
  });

  it('a later price change never rewrites a past movement\'s recorded unit cost (tested via the returned movement snapshot)', async () => {
    const engine = new InventoryEngineService();
    const { tx: tx1 } = makeFakeTx({ quantityOnHand: '100', averageCost: '10' });
    const sale = await engine.applyMovement(tx1, {
      ...baseParams,
      quantityDelta: -10,
      movementType: 'SALE',
      allowNegative: false,
    });
    expect(sale.movement.unitCostAtMovement.toString()).toBe('10');

    // A subsequent purchase at a much higher cost changes the AVERAGE
    // cost, but the historical `sale` object above (and, in the real
    // system, its persisted stock_movements row) is untouched - nothing
    // about applying a later movement can reach back and mutate it.
    const { tx: tx2 } = makeFakeTx({ quantityOnHand: '90', averageCost: '10' });
    await engine.applyMovement(tx2, {
      ...baseParams,
      quantityDelta: 10,
      movementType: 'PURCHASE',
      unitCostOverride: 100,
      allowNegative: false,
    });
    expect(sale.movement.unitCostAtMovement.toString()).toBe('10');
  });

  it('rejects a decrease that would go negative when allowNegative is false', async () => {
    const engine = new InventoryEngineService();
    const { tx, state } = makeFakeTx({ quantityOnHand: '5', averageCost: '10' });

    await expect(
      engine.applyMovement(tx, {
        ...baseParams,
        quantityDelta: -10,
        movementType: 'SALE',
        allowNegative: false,
      }),
    ).rejects.toBeInstanceOf(InsufficientStockDomainError);

    // Nothing was mutated - the balance state is untouched by the rejection.
    expect(state.quantity_on_hand).toBe('5');
  });

  it('allows a decrease past zero when allowNegative is true, and flags the movement', async () => {
    const engine = new InventoryEngineService();
    const { tx } = makeFakeTx({ quantityOnHand: '5', averageCost: '10' });

    const result = await engine.applyMovement(tx, {
      ...baseParams,
      quantityDelta: -10,
      movementType: 'SALE',
      allowNegative: true,
    });

    expect(result.quantityOnHand.toString()).toBe('-5');
    expect(result.movement.isNegativeStock).toBe(true);
    expect(result.averageCost.toString()).toBe('10'); // COGS basis still the prior average
  });

  it('crossing from a negative balance back to positive resets the cost basis to the new purchase cost', async () => {
    const engine = new InventoryEngineService();
    const { tx } = makeFakeTx({ quantityOnHand: '-5', averageCost: '10' });

    const result = await engine.applyMovement(tx, {
      ...baseParams,
      quantityDelta: 20,
      movementType: 'PURCHASE',
      unitCostOverride: 15,
      allowNegative: false,
    });

    expect(result.quantityOnHand.toString()).toBe('15');
    expect(result.averageCost.toString()).toBe('15'); // reset, not weighted against -5
  });

  it('rejects a zero quantityDelta outright (not a movement at all)', async () => {
    const engine = new InventoryEngineService();
    const { tx } = makeFakeTx({ quantityOnHand: '10', averageCost: '5' });

    await expect(
      engine.applyMovement(tx, {
        ...baseParams,
        quantityDelta: 0,
        movementType: 'ADJUSTMENT',
        allowNegative: false,
      }),
    ).rejects.toThrow();
  });

  describe('applyAbsoluteQuantity (stock count approval)', () => {
    it('computes the delta from the LOCKED balance, not a value the caller might have peeked earlier', async () => {
      const engine = new InventoryEngineService();
      // Simulates: caller "peeked" 100 earlier, but by the time this runs
      // (i.e. once the lock is actually acquired) the true balance is 80 -
      // a concurrent sale happened in between. The engine must react to
      // the locked value (80), not any earlier peek.
      const { tx } = makeFakeTx({ quantityOnHand: '80', averageCost: '10' });

      const result = await engine.applyAbsoluteQuantity(tx, {
        ...baseParams,
        targetQuantity: 95, // the physical count
        movementType: 'ADJUSTMENT',
        allowNegative: false,
      });

      expect(result.movement).not.toBeNull();
      // delta must be 95 - 80 = 15, NOT 95 - 100 = -5.
      expect(result.movement!.quantityBase.toString()).toBe('15');
      expect(result.quantityOnHand.toString()).toBe('95');
    });

    it('creates no movement at all when the target already equals the current balance', async () => {
      const engine = new InventoryEngineService();
      const { tx } = makeFakeTx({ quantityOnHand: '50', averageCost: '10' });

      const result = await engine.applyAbsoluteQuantity(tx, {
        ...baseParams,
        targetQuantity: 50,
        movementType: 'ADJUSTMENT',
        allowNegative: false,
      });

      expect(result.movement).toBeNull();
      expect(result.quantityOnHand.toString()).toBe('50');
    });

    it('a lower counted quantity produces a negative (decrease) delta using the current average cost as COGS', async () => {
      const engine = new InventoryEngineService();
      const { tx } = makeFakeTx({ quantityOnHand: '100', averageCost: '8' });

      const result = await engine.applyAbsoluteQuantity(tx, {
        ...baseParams,
        targetQuantity: 60,
        movementType: 'ADJUSTMENT',
        allowNegative: false,
      });

      expect(result.movement!.quantityBase.toString()).toBe('-40');
      expect(result.movement!.unitCostAtMovement.toString()).toBe('8');
      expect(result.averageCost.toString()).toBe('8'); // decrease never changes average cost
    });
  });
});
