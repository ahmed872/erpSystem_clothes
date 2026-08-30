-- Row-Level Security for the Phase 8E serial-capture link, same
-- default-deny pattern as every prior phase.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sale_item_serials']
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
