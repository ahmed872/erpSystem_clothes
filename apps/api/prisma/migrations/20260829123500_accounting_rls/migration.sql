-- Row-Level Security for Phase 6 (Accounting) tables, same default-deny
-- pattern as every prior phase's RLS migration. Every Phase 6 table
-- carries its own business_id, so all of them use the direct-column
-- policy - no transitive join-table policies are needed this phase.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'accounts', 'fiscal_periods', 'accounting_mapping_rules',
    'journal_entries', 'journal_entry_lines'
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
