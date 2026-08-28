-- Extends the restricted erp_app runtime role (created in migration
-- 20260828121600_lockdown_app_role) with exactly the privileges each new
-- Phase 2 table needs. Same rationale as that migration: DELETE is
-- withheld wherever the domain requires it to be structurally impossible,
-- not just discouraged by application code.

-- Reference/config data: hard delete is fine when unused (enforced by
-- application-layer checks + FK RESTRICT, not by withholding the grant),
-- same treatment as Role in migration 20260828121600_lockdown_app_role.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "categories", "brands", "uoms", "product_attributes", "product_attribute_values",
  "product_uoms", "barcodes", "price_lists", "product_prices",
  "variant_attribute_values", "bundle_items"
  TO erp_app;

-- Products and their variants become heavily referenced by Inventory
-- (Phase 3), Purchasing (Phase 4) and Sales (Phase 5). No hard delete at
-- the database-privilege level, ever - status (ACTIVE/INACTIVE/
-- DISCONTINUED) is the only supported way to retire one.
GRANT SELECT, INSERT, UPDATE ON "products", "product_variants" TO erp_app;

-- Append-only price change ledger: immutable at the DB privilege level,
-- same treatment as audit_logs.
GRANT SELECT, INSERT ON "product_price_history" TO erp_app;
