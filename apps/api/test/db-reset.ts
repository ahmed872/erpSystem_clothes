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
        "settings", "warehouses", "branches", "roles", "users",
        "stock_movements", "stock_balances", "inventory_lots", "serial_numbers",
        "stock_count_items", "stock_counts", "stock_transfer_items", "stock_transfers",
        "purchase_payments", "purchase_return_items", "purchase_returns",
        "purchase_receipt_items", "purchase_receipts", "purchase_items", "purchases",
        "supplier_transactions", "suppliers",
        "product_price_history", "product_prices", "price_lists",
        "bundle_items", "barcodes", "product_uoms", "variant_attribute_values",
        "product_variants", "products", "product_attribute_values", "product_attributes",
        "uoms", "brands", "categories",
        "businesses"
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await admin.$disconnect();
  }
}
