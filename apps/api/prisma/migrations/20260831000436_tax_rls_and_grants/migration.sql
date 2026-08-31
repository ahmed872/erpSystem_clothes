-- Phase 10 (BD-18): Row-Level Security and grants for the tax configuration
-- table. Same default-deny pattern as every prior phase.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE taxes ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE taxes FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY taxes_tenant_isolation ON taxes USING (business_id = current_setting(''app.current_tenant_id'', true)) WITH CHECK (business_id = current_setting(''app.current_tenant_id'', true))';
END
$$;

-- Ordinary configuration: created, renamed, re-rated and retired over its
-- life. No DELETE - a tax that has ever been applied to a sale must stay
-- resolvable, and `is_active` carries retirement instead.
GRANT SELECT, INSERT, UPDATE ON "taxes" TO erp_app;
