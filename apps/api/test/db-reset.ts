import { PrismaClient } from '@prisma/client';

/**
 * Truncates every tenant-scoped table between e2e test files, using the
 * DATABASE_URL (migration/owner) connection so it isn't itself subject to
 * RLS. Keeps the global `permissions` catalog seeded by the test DB setup.
 */
export async function resetDatabase(): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    await admin.$executeRawUnsafe(`
      TRUNCATE TABLE
        "audit_logs", "refresh_tokens", "user_roles", "user_branches", "role_permissions",
        "settings", "warehouses", "branches", "roles", "users", "businesses"
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await admin.$disconnect();
  }
}
