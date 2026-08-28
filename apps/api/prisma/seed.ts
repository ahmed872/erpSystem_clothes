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
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
