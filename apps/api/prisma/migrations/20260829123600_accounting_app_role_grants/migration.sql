-- Extends erp_app with exactly the privileges each Phase 6 table needs.
--
-- accounts: SELECT+INSERT+UPDATE - a real in-place mutation lifecycle
-- (rename, deactivate), same posture as customers/shifts (Phase 5). Never
-- DELETE - a system or tenant-created account is deactivated, never
-- removed, matching every "protected default" entity in this codebase.
--
-- fiscal_periods: SELECT+INSERT+UPDATE - genuinely mutates in place
-- (OPEN -> CLOSED, and a reopen transitions it back), AND (applying the
-- Phase 5 lesson UP FRONT this time instead of discovering it live via a
-- failing test) postEntry takes `SELECT ... FOR UPDATE` on the resolved
-- period row to serialize against a concurrent period-close - Postgres
-- requires the UPDATE privilege for that regardless of whether a real
-- content-changing UPDATE follows in the same call. Never DELETE - a
-- period with posted entries against it can never be removed.
--
-- accounting_mapping_rules: SELECT+INSERT only. Seeded once per business
-- (onboarding, or the one-time bootstrap for pre-existing businesses) and
-- never mutated by any Phase 6 code path - no manual "reconfigure this
-- mapping" endpoint exists yet (see Known Issues), so UPDATE is correctly
-- withheld rather than granted preemptively for a capability that doesn't
-- exist.
--
-- journal_entries / journal_entry_lines: SELECT+INSERT ONLY - true
-- append-only event records (Phase 0 §6.2: no UPDATE on a Posted entry,
-- corrections are new reversal entries only). Unlike `sales` (Phase 5),
-- NEITHER of these needs a locking-only UPDATE grant: postEntry never
-- issues `SELECT ... FOR UPDATE` against journal_entries itself (the
-- reversal race is closed by the (business_id, reversal_of_id) unique
-- index instead - the same nullable-opt-in-unique pattern every
-- idempotencyKey column in this schema already uses, not a row lock),
-- and journal_entry_lines is never locked at all.

GRANT SELECT, INSERT, UPDATE ON
  "accounts", "fiscal_periods"
  TO erp_app;

GRANT SELECT, INSERT ON
  "accounting_mapping_rules",
  "journal_entries", "journal_entry_lines"
  TO erp_app;
