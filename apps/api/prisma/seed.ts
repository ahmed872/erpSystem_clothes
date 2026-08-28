import { PrismaClient } from '@prisma/client';
import { PERMISSION_CODES } from '@retail/shared-types';

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'users.view': 'View users',
  'users.create': 'Create users',
  'users.edit': 'Edit users',
  'users.delete': 'Delete users',
  'users.manage_roles': 'Assign/revoke roles for a user',
  'roles.view': 'View roles',
  'roles.create': 'Create roles',
  'roles.edit': 'Edit roles',
  'roles.delete': 'Delete roles',
  'permissions.view': 'View the permission catalog',
  'business.view': 'View business profile',
  'business.edit': 'Edit business profile',
  'settings.view': 'View settings',
  'settings.edit': 'Edit settings',
  'branches.view': 'View branches',
  'branches.create': 'Create branches',
  'branches.edit': 'Edit branches',
  'branches.delete': 'Deactivate branches',
  'warehouses.view': 'View warehouses',
  'warehouses.create': 'Create warehouses',
  'warehouses.edit': 'Edit warehouses',
  'warehouses.delete': 'Deactivate warehouses',
  'audit.view': 'View audit logs',
  'products.view': 'View products and variants (excluding cost)',
  'products.view_cost': 'View product/variant cost fields',
  'products.create': 'Create products and variants',
  'products.edit': 'Edit product/variant general fields',
  'products.change_price': 'Change product/variant selling price',
  'products.change_cost': 'Change product/variant cost',
  'products.delete': 'Deactivate/discontinue products or variants',
  'categories.view': 'View categories',
  'categories.create': 'Create categories',
  'categories.edit': 'Edit categories',
  'categories.delete': 'Delete categories',
  'brands.view': 'View brands',
  'brands.create': 'Create brands',
  'brands.edit': 'Edit brands',
  'brands.delete': 'Delete brands',
  'uoms.view': 'View units of measure',
  'uoms.create': 'Create units of measure',
  'uoms.edit': 'Edit units of measure',
  'uoms.delete': 'Delete units of measure',
  'attributes.view': 'View product attributes and their values',
  'attributes.create': 'Create product attributes and values',
  'attributes.edit': 'Edit product attributes and values',
  'attributes.delete': 'Delete product attributes and values',
  'pricelists.view': 'View price lists and their entries',
  'pricelists.create': 'Create price lists',
  'pricelists.edit': 'Edit price lists',
  'pricelists.manage_prices': 'Set variant prices within a price list',
  'inventory.view': 'View stock balances, movements, transfers, and counts',
  'inventory.opening_stock': 'Record opening stock for a variant/warehouse',
  'inventory.receive': 'Receive stock (purchases, sales returns)',
  'inventory.consume': 'Consume stock (sales, purchase returns)',
  'inventory.adjust': 'Record stock adjustments, damage, loss, expiry, internal consumption',
  'inventory.allow_negative': 'Allow a specific stock movement to push a balance negative when the tenant setting permits it',
  'inventory.transfer_create': 'Create a stock transfer between warehouses',
  'inventory.transfer_send': 'Send a stock transfer (decrements source warehouse)',
  'inventory.transfer_receive': 'Receive a stock transfer (increments destination warehouse)',
  'inventory.stock_count_create': 'Create and submit a stock count',
  'inventory.stock_count_approve': 'Approve a stock count and apply resulting adjustments',
  'suppliers.view': 'View suppliers and their transaction ledger/balance',
  'suppliers.create': 'Create a supplier',
  'suppliers.edit': 'Edit a supplier',
  'suppliers.delete': 'Deactivate a supplier',
  'purchases.view': 'View purchases, purchase items, receipts, and returns',
  'purchases.create': 'Create a purchase (draft)',
  'purchases.edit': 'Edit a draft purchase',
  'purchases.approve': 'Approve a purchase, committing it for receiving',
  'purchases.cancel': 'Cancel a purchase',
  'purchases.receive': 'Receive goods against an approved purchase, applying inventory and supplier ledger updates',
  'purchases.return': 'Return previously received goods to a supplier, reversing inventory and posting a supplier credit',
  'purchases.pay': 'Record a payment made to a supplier against a purchase',
};

/**
 * Seeds the global permission catalog. Must run with DATABASE_URL (the
 * migration/owner role) - the runtime `erp_app` role only has SELECT on
 * `permissions` (see migration 20260828121600_lockdown_app_role).
 */
async function main() {
  const prisma = new PrismaClient();
  try {
    for (const code of PERMISSION_CODES) {
      await prisma.permission.upsert({
        where: { code },
        update: { description: PERMISSION_DESCRIPTIONS[code] ?? code },
        create: { code, description: PERMISSION_DESCRIPTIONS[code] ?? code },
      });
    }
    // eslint-disable-next-line no-console
    console.log(`Seeded ${PERMISSION_CODES.length} permissions.`);

    // A Role's grants are a stored snapshot (RolePermission rows), not
    // computed dynamically from "is this the owner role" - so a business
    // onboarded before a new permission code existed would otherwise lose
    // access to it forever. BUSINESS_OWNER is the one role template with a
    // hard invariant ("the owner always has everything"), so backfill it
    // here on every seed run; other templates' new defaults only apply to
    // businesses onboarded from now on (existing tenants can grant them
    // manually via the Roles API - see docs/state/PROJECT_STATE.md).
    const allPermissions = await prisma.permission.findMany({ select: { id: true } });
    const ownerRoles = await prisma.role.findMany({ where: { name: 'BUSINESS_OWNER', isSystem: true } });
    let backfilled = 0;
    for (const role of ownerRoles) {
      const existing = await prisma.rolePermission.findMany({ where: { roleId: role.id }, select: { permissionId: true } });
      const existingIds = new Set(existing.map((rp) => rp.permissionId));
      const missing = allPermissions.filter((p) => !existingIds.has(p.id));
      if (missing.length > 0) {
        await prisma.rolePermission.createMany({
          data: missing.map((p) => ({ roleId: role.id, permissionId: p.id })),
          skipDuplicates: true,
        });
        backfilled += missing.length;
      }
    }
    if (backfilled > 0) {
      // eslint-disable-next-line no-console
      console.log(`Backfilled ${backfilled} permission grant(s) across ${ownerRoles.length} BUSINESS_OWNER role(s).`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
