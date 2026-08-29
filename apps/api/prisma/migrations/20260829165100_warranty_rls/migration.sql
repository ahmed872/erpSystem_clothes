-- Row-Level Security for Phase 8A (Warranty) tables, same default-deny
-- pattern as every prior phase's RLS migration. Both tables carry their
-- own business_id, so both use the direct-column policy - no transitive
-- join-table policies are needed.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['warranties', 'warranty_claims']
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
