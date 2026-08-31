import { PrismaClient } from '@prisma/client';

/**
 * Phase 11 — THE GUARD THAT SHOULD HAVE BEEN HERE FROM THE START.
 *
 * This function TRUNCATEs every table in the database it is pointed at,
 * as the owner role, bypassing RLS. It reads its target from an
 * environment variable. Nothing stopped it from being pointed at a
 * production database by a stale shell, a mistyped command, a CI job with
 * the wrong secret, or an editor that helpfully loaded the wrong `.env` -
 * and there is no undo.
 *
 * Two independent conditions must BOTH hold, so a single mistake is never
 * enough:
 *
 *   1. NODE_ENV must be exactly `test`.
 *   2. The database NAME must look like a test database.
 *
 * A production URL that happens to run under NODE_ENV=test still fails on
 * the name; a database called `erp_test` reached from a non-test
 * environment still fails on NODE_ENV. The error names what was wrong
 * without printing the URL, because a connection string carries a
 * password.
 */
export function assertSafeToTruncate(databaseUrl: string | undefined): void {
  if (!databaseUrl) {
    throw new Error('refusing to reset: DATABASE_URL is not set');
  }
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `refusing to reset the database: NODE_ENV is "${process.env.NODE_ENV ?? 'unset'}", not "test". ` +
        'This function truncates every table and cannot be undone.',
    );
  }

  let name: string;
  try {
    name = new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    throw new Error('refusing to reset: DATABASE_URL is not a parseable URL');
  }
  if (!/(^|[_-])test($|[_-])|^test/i.test(name)) {
    throw new Error(
      `refusing to reset the database "${name}": its name does not identify it as a test database. ` +
        'Expected a name containing "test". This function truncates every table and cannot be undone.',
    );
  }
}

/**
 * Truncates every tenant-scoped table between e2e test files, using the
 * DATABASE_URL (migration/owner) connection so it isn't itself subject to
 * RLS. Keeps the global `permissions` catalog seeded by the test DB setup.
 */
export async function resetDatabase(): Promise<void> {
  assertSafeToTruncate(process.env.DATABASE_URL);
  const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    await admin.$executeRawUnsafe(`
      TRUNCATE TABLE
        "audit_logs", "refresh_tokens", "user_roles", "user_branches", "role_permissions",
        "settings", "warehouses", "branches", "roles", "users",
        "stock_movements", "stock_balances", "inventory_lots", "serial_numbers",
        "stock_count_items", "stock_counts",
        "stock_transfer_item_serials", "stock_transfer_items", "stock_transfers",
        "purchase_payments", "purchase_return_item_serials", "purchase_return_items", "purchase_returns",
        "purchase_receipt_item_serials", "purchase_receipt_items", "purchase_receipts", "purchase_items", "purchases",
        "supplier_transactions", "suppliers",
        "warranty_claims", "warranties",
        "sale_return_item_serials", "sale_promotion_applications", "promotions", "sale_item_serials",
        "sale_return_items", "sale_returns", "sale_payments", "sale_items",
        "held_sale_items", "held_sales", "sales",
        "cash_transactions", "shifts", "cash_registers", "taxes",
        "customer_transactions", "customer_points", "customers",
        "expenses", "expense_categories",
        "journal_entry_lines", "journal_entries", "accounting_mapping_rules", "fiscal_periods", "accounts",
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
