-- Extends erp_app with exactly the privileges each Phase 3 table needs.
-- Every single one of these tables withholds DELETE, on top of Phase 1/2's
-- precedent of withholding it for AuditLog/ProductPriceHistory/businesses/
-- products/product_variants: nothing in the inventory domain is ever a
-- record that should vanish. stock_movements goes further still and
-- withholds UPDATE too - it is the ledger itself, truly append-only
-- (Phase 3 instruction: never edit or delete a historical StockMovement).
-- A correction is always a new StockMovement row (movementType
-- AUTHORIZED_CORRECTION) that references the one it corrects.

GRANT SELECT, INSERT ON "stock_movements" TO erp_app;

GRANT SELECT, INSERT, UPDATE ON
  "stock_balances", "inventory_lots", "serial_numbers",
  "stock_counts", "stock_count_items",
  "stock_transfers", "stock_transfer_items"
  TO erp_app;
