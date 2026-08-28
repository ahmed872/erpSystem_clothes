import { TenantTx } from '../../../common/prisma/prisma.service';

const NEGATIVE_INVENTORY_SETTING_KEY = 'inventory.allow_negative_stock';

/**
 * Negative inventory is Disabled by Default (Phase 0 §48). Going negative
 * requires BOTH the tenant-level Setting to be explicitly turned on AND
 * the acting user to hold the `inventory.allow_negative` permission -
 * the setting alone is not enough, matching the spec's "يجب أن يكون لها
 * Permission" requirement. Reuses the generic Setting store from Phase 1
 * rather than adding a dedicated column, since it's exactly the
 * per-business key/value config that module already exists for.
 */
export async function resolveAllowNegative(
  tx: TenantTx,
  businessId: string,
  actorPermissions: Set<string>,
): Promise<boolean> {
  if (!actorPermissions.has('inventory.allow_negative')) return false;

  const setting = await tx.setting.findUnique({
    where: { businessId_key: { businessId, key: NEGATIVE_INVENTORY_SETTING_KEY } },
  });
  return setting?.value === true;
}
