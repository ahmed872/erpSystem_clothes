-- Row-Level Security for Phase 4 (Purchasing) tables, same default-deny
-- pattern as migrations 20260828121500_enable_row_level_security (Phase 1),
-- 20260828124500_catalog_rls (Phase 2), and 20260828131600_inventory_rls
-- (Phase 3). Every Phase 4 table carries its own business_id (Phase 2
-- precedent), so all of them use the direct-column policy - no transitive
-- join-table policies are needed this phase.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'suppliers', 'supplier_transactions',
    'purchases', 'purchase_items',
    'purchase_receipts', 'purchase_receipt_items',
    'purchase_returns', 'purchase_return_items',
    'purchase_payments'
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
