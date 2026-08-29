-- Extends erp_app with exactly the privileges the Phase 8B loyalty ledger
-- needs, and no more.
--
-- customer_points: SELECT + INSERT ONLY. No UPDATE, no DELETE, at all.
-- This is the strictest grant in the system, matching journal_entries /
-- journal_entry_lines (Phase 6) rather than the "append-only plus a
-- narrow locking UPDATE" compromise some earlier tables needed. That is
-- deliberate and is what makes "append-only" a DATABASE guarantee here
-- rather than an application convention: a customer's point balance is
-- always SUM(points), so a single UPDATE to a historical row would
-- silently rewrite a balance with no audit trail anywhere.
--
-- Corrections are compensating rows (RETURN_CLAWBACK / ADJUSTMENT),
-- never edits - the same posture SaleReturn takes towards Sale and
-- reverseEntry takes towards JournalEntry.
--
-- NOTE on locking (the Phase 5 `sales` lesson applied up front for the
-- third phase running): PostgreSQL requires the UPDATE privilege to
-- execute SELECT ... FOR UPDATE, so a table that needs row locking cannot
-- be SELECT+INSERT only. customer_points deliberately needs no such
-- grant, because the concurrency boundary for a loyalty balance is the
-- CUSTOMER row, not the ledger rows: an operation that must not overspend
-- takes `SELECT ... FOR UPDATE` on `customers` (which already carries the
-- UPDATE grant from Phase 5) and only then reads SUM(points) and inserts.
-- Locking existing ledger rows would not even be correct - it cannot
-- block a concurrent INSERT of a new one.

GRANT SELECT, INSERT ON
  "customer_points"
  TO erp_app;
