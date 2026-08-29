-- Extends erp_app with exactly the privileges each Phase 8A table needs.
--
-- warranties: SELECT + INSERT + UPDATE. UPDATE is genuinely required -
-- a warranty's `status` transitions in place (ACTIVE -> EXPIRED |
-- CLAIMED | VOID), the same in-place lifecycle `shifts` and
-- `fiscal_periods` already have. Never DELETE: an issued warranty is a
-- record of an obligation to a customer and is voided, never removed.
--
-- warranty_claims: SELECT + INSERT + UPDATE. Claim rows are only ever
-- INSERTed and then transitioned OPEN -> RESOLVED | REJECTED; the UPDATE
-- grant exists solely for that status transition, which the
-- `warranty_claims_resolution_audit_consistent` CHECK forces to carry its
-- own audit trail (resolved_at/resolved_by) so a transition can never
-- silently overwrite history. `claimed_at` and `description` are never
-- rewritten by any application code path. Never DELETE: claim history is
-- evidence and must survive.
--
-- NOTE (applying the Phase 5 `sales` lesson up front rather than
-- discovering it live): neither table is ever row-locked via
-- `SELECT ... FOR UPDATE` by Phase 8A, so neither needs an UPDATE grant
-- for locking purposes - both have it for real content mutation. Claim
-- registration's duplicate protection is the
-- (business_id, sale_item_id, serial_number_id) unique index on
-- warranties, not a lock.

GRANT SELECT, INSERT, UPDATE ON
  "warranties", "warranty_claims"
  TO erp_app;
