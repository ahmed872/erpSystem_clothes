-- Row-Level Security for the Phase 8B loyalty ledger, same default-deny
-- pattern as every prior phase's RLS migration. `customer_points` carries
-- its own business_id, so the direct-column policy applies - no
-- transitive join-table policy is needed.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_points']
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
