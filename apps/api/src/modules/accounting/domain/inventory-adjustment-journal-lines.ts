import { AccountingMappingKey, Prisma, StockMovementType } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { PostEntryLineInput } from '../../../engines/accounting/accounting-engine.service';
import { resolveMappedAccounts } from './resolve-mapped-account';

export interface InventoryAdjustmentJournalInput {
  movementType: StockMovementType;
  /** Signed, base UOM - positive = increase, negative = decrease (same
   * sign convention as InventoryEngineService.applyMovement's own
   * quantityDelta). */
  quantityDelta: Prisma.Decimal;
  /** The engine's own unit_cost_at_movement for this exact movement -
   * never a recomputed/current cost. */
  unitCostAtMovement: Prisma.Decimal;
}

/**
 * AdjustStockUseCase's five reachable movement types (ADJUSTMENT, DAMAGE,
 * LOSS, EXPIRY, INTERNAL_CONSUMPTION - see adjustStockSchema) map to
 * exactly two GL treatments: INTERNAL_CONSUMPTION always debits the
 * dedicated expense account; every other type debits Inventory Shrinkage
 * on a decrease or credits Inventory Gain on an increase (ADJUSTMENT is
 * the one type that can legitimately go either way - "found extra
 * stock" vs "shrinkage" - keyed off the movement's actual sign, not an
 * assumption baked into the type name).
 *
 * KNOWN LIMITATION, stated explicitly (not hidden): AdjustStockUseCase
 * has no idempotencyKey (Phase 3 never needed one for this endpoint). A
 * network retry of an adjustment request creates a SECOND, genuinely new
 * StockMovement (a pre-existing Phase 3 gap, not introduced here), and
 * this function will then correctly-but-unavoidably post a SECOND,
 * independently-balanced journal entry for that second movement - the
 * (businessId, sourceType, sourceId) uniqueness on JournalEntry cannot
 * catch this, because sourceId is the new movement's own id, not a
 * request-level key. This is Phase 3's duplicate-movement exposure
 * inherited into the ledger, not a new Accounting-specific correctness
 * defect - see PROJECT_STATE.md Known Issues.
 */
export async function buildInventoryAdjustmentJournalLines(tx: TenantTx, businessId: string, input: InventoryAdjustmentJournalInput): Promise<PostEntryLineInput[]> {
  const amount = input.quantityDelta.abs().times(input.unitCostAtMovement);
  if (!amount.greaterThan(0)) return [];

  if (input.movementType === 'INTERNAL_CONSUMPTION') {
    const accounts = await resolveMappedAccounts(tx, businessId, ['INTERNAL_CONSUMPTION_EXPENSE', 'INVENTORY_ASSET']);
    return [
      { accountId: accounts.get('INTERNAL_CONSUMPTION_EXPENSE')!, debit: amount, description: 'Internal consumption' },
      { accountId: accounts.get('INVENTORY_ASSET')!, credit: amount, description: 'Inventory consumed internally' },
    ];
  }

  const isIncrease = input.quantityDelta.greaterThan(0);
  const keys: AccountingMappingKey[] = isIncrease ? ['INVENTORY_ASSET', 'INVENTORY_GAIN'] : ['INVENTORY_SHRINKAGE', 'INVENTORY_ASSET'];
  const accounts = await resolveMappedAccounts(tx, businessId, keys);

  if (isIncrease) {
    return [
      { accountId: accounts.get('INVENTORY_ASSET')!, debit: amount, description: `Inventory adjustment: ${input.movementType}` },
      { accountId: accounts.get('INVENTORY_GAIN')!, credit: amount, description: 'Inventory gain / correction' },
    ];
  }
  return [
    { accountId: accounts.get('INVENTORY_SHRINKAGE')!, debit: amount, description: `Inventory write-off: ${input.movementType}` },
    { accountId: accounts.get('INVENTORY_ASSET')!, credit: amount, description: 'Inventory reduction' },
  ];
}
