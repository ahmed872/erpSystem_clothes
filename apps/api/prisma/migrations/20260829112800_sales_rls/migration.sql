-- Row-Level Security for Phase 5 (Sales/POS) tables, same default-deny
-- pattern as every prior phase's RLS migration. Every Phase 5 table
-- carries its own business_id, so all of them use the direct-column
-- policy - no transitive join-table policies are needed this phase.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customers', 'customer_transactions',
    'shifts',
    'sales', 'sale_items', 'sale_payments',
    'sale_returns', 'sale_return_items'
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
