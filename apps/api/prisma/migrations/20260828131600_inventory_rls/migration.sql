-- Row-Level Security for Phase 3 (Inventory Engine) tables, same
-- default-deny pattern as migrations 20260828121500_enable_row_level_security
-- (Phase 1) and 20260828124500_catalog_rls (Phase 2).

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stock_movements', 'stock_balances', 'inventory_lots', 'serial_numbers',
    'stock_counts', 'stock_transfers'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (business_id = current_setting(''app.current_tenant_id'', true)) WITH CHECK (business_id = current_setting(''app.current_tenant_id'', true))',
      t || '_tenant_isolation', t
    );
  END LOOP;
END
$$;

-- Pure join tables without their own business_id, scoped transitively via
-- their parent row's tenant (same pattern as Phase 1/2 join tables).

ALTER TABLE "stock_count_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_count_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_count_items_tenant_isolation ON "stock_count_items"
  USING (
    EXISTS (
      SELECT 1 FROM "stock_counts" sc
      WHERE sc.id = "stock_count_items".stock_count_id
        AND sc.business_id = current_setting('app.current_tenant_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "stock_counts" sc
      WHERE sc.id = "stock_count_items".stock_count_id
        AND sc.business_id = current_setting('app.current_tenant_id', true)
    )
  );

ALTER TABLE "stock_transfer_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_transfer_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_transfer_items_tenant_isolation ON "stock_transfer_items"
  USING (
    EXISTS (
      SELECT 1 FROM "stock_transfers" st
      WHERE st.id = "stock_transfer_items".stock_transfer_id
        AND st.business_id = current_setting('app.current_tenant_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "stock_transfers" st
      WHERE st.id = "stock_transfer_items".stock_transfer_id
        AND st.business_id = current_setting('app.current_tenant_id', true)
    )
  );
