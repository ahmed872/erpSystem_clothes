-- Phase 7 (Reporting) adds NO tables, NO views, NO materialized views and
-- NO reporting projections - reporting is a strictly read-only layer over
-- the existing source-of-truth tables, using privileges erp_app already
-- has. The only schema change this phase needs is indexes.
--
-- Every index below was identified by auditing the ACTUAL planned report
-- queries against the live schema, not added speculatively. Each one
-- backs a specific, named query pattern:
--
-- 1. sales (business_id, created_at)
--    `sales` had NO index on created_at at all. EVERY date-ranged sales
--    report and every dashboard KPI filters on
--    `business_id = ? AND created_at >= ? AND created_at < ?` - without
--    this, all of them sequentially scan the sales table.
--
-- 2. journal_entries (business_id, entry_date)
--    `journal_entries` had NO index on entry_date. The P&L and the
--    Balance Sheet are entirely date-bounded over this column, and the
--    General Ledger report filters on it too.
--
-- 3. sale_items (business_id, variant_id)
--    Sales-by-product and sales-by-category aggregate SaleItems grouped
--    by variant (category is reached by joining variant -> product).
--    sale_items previously had only (sale_id, variant_id) unique plus
--    single-column indexes.
--
-- 4. sales (business_id, created_by)
--    Sales-by-employee/user groups on created_by, which was entirely
--    unindexed.
--
-- 5. sale_payments (business_id, received_at)
--    The payment-method breakdown filters payments by period before
--    grouping on method.
--
-- Deliberately NOT added: any index on stock_movements. It already
-- carries created_at, movement_type, (warehouse_id, variant_id) and
-- (reference_type, reference_id), which cover every planned inventory
-- report - adding more would be speculative.

CREATE INDEX "sales_business_id_created_at_idx" ON "sales" ("business_id", "created_at");

CREATE INDEX "journal_entries_business_id_entry_date_idx" ON "journal_entries" ("business_id", "entry_date");

CREATE INDEX "sale_items_business_id_variant_id_idx" ON "sale_items" ("business_id", "variant_id");

CREATE INDEX "sales_business_id_created_by_idx" ON "sales" ("business_id", "created_by");

CREATE INDEX "sale_payments_business_id_received_at_idx" ON "sale_payments" ("business_id", "received_at");
