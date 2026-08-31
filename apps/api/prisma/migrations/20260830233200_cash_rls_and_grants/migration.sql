-- Phase 10 (BD-17): Row-Level Security and grants for the cash/till tables.
-- Same default-deny pattern as every prior phase: RLS + FORCE RLS, exactly
-- one policy per table carrying BOTH a USING and a WITH CHECK clause, so a
-- tenant can neither read nor write another tenant's rows even if the
-- application forgets its predicate.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_registers', 'cash_transactions']
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

-- cash_registers is ordinary configuration: it is created, renamed and
-- deactivated over its life, so it carries UPDATE. It is never hard-deleted
-- (is_active carries retirement), so no DELETE grant is issued - a register
-- that once hosted a shift must remain resolvable forever.
GRANT SELECT, INSERT, UPDATE ON "cash_registers" TO erp_app;

-- cash_transactions is APPEND-ONLY: SELECT + INSERT, no UPDATE, no DELETE.
--
-- This is the guarantee that makes expected cash trustworthy. Expected cash
-- is DERIVED as opening_float + SUM(amount), never stored; if a row could be
-- edited or removed after the fact, that derivation would be worth nothing
-- and a variance could be made to disappear. Withholding the privileges at
-- the database turns "we do not rewrite cash history" from a convention
-- into something the database itself enforces - matching customer_points,
-- stock_movements, journal_entries and sale_item_serials.
GRANT SELECT, INSERT ON "cash_transactions" TO erp_app;

-- shifts already carries SELECT, INSERT, UPDATE from Phase 5 (it needs
-- UPDATE both for the close transition and, mechanically, for
-- SELECT ... FOR UPDATE - see Known Issue #30). Phase 10 adds columns to it
-- but no new privilege, so nothing is granted here for shifts.
