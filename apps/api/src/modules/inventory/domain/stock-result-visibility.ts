import { EffectivePermissionsService } from '../../../common/authorization/effective-permissions.service';
import { TenantTx } from '../../../common/prisma/prisma.service';

/**
 * Phase 15 — THE ONE PLACE THAT DECIDES WHETHER INVENTORY COST LEAVES THE
 * SERVER.
 *
 * Inventory's READ paths already stripped cost for a caller without
 * `products.view_cost`: `GET /inventory/balances` omits `averageCost`, and
 * `GET /inventory/movements` omits `unitCostAtMovement`. Its WRITE paths
 * did not. `POST /inventory/opening-stock`, `/receipts`, `/consumptions`
 * and `/adjustments` each returned the engine's freshly-recomputed
 * `averageCost` — and consumption also returned `cogsPerUnit` — to a
 * caller who could not read either figure anywhere else.
 *
 * REACHABLE, NOT THEORETICAL, and worse here than in the catalogue: the
 * moving-average cost of a warehouse is exactly what repeated receipts at
 * known quantities would let someone solve for. `inventory.receive` and
 * `inventory.adjust` are separate grants from `products.view_cost`, and a
 * stockkeeper who moves goods without being shown the shop's buying price
 * is an ordinary arrangement — a role this product supports directly,
 * since tenants define their own.
 *
 * This is the same defect Phase 14 found in the catalogue, in a second
 * module. The rule is therefore expressed once, here, and applied on the
 * way out of every mutation: a response shape must not depend on which
 * verb produced it.
 *
 * NOTE WHAT IS NOT STRIPPED. `quantityOnHand` and `movementId` are not
 * cost and stay for everyone — a stockkeeper must be able to see the
 * result of the move they just made, which is the whole point of the
 * server returning it.
 */
export async function canViewInventoryCost(
  effectivePermissions: EffectivePermissionsService,
  tx: TenantTx,
  userId: string,
): Promise<boolean> {
  const permissions = await effectivePermissions.get(tx, userId);
  return permissions?.has('products.view_cost') ?? false;
}

/** Cost-bearing keys of a stock-mutation result. */
const STOCK_COST_KEYS = ['averageCost', 'cogsPerUnit'] as const;

/**
 * Removes cost from a mutation result unless the caller may see it.
 * REMOVAL, not nulling — the same posture the read paths, the catalogue
 * and the blind-close shift figures all use, so a client renders "what
 * arrived" instead of re-deciding a permission.
 */
export function stripStockCost<T extends object>(result: T, canViewCost: boolean): T {
  if (canViewCost) return result;
  const clone = { ...result } as Record<string, unknown>;
  for (const key of STOCK_COST_KEYS) delete clone[key];
  return clone as T;
}
