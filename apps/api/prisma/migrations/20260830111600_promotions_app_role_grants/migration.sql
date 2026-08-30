-- Extends erp_app with exactly what each Phase 8D table needs.
--
-- promotions: SELECT + INSERT + UPDATE. UPDATE is genuinely required -
-- a promotion is CONFIGURATION that is edited (renamed, re-dated,
-- re-parameterised) and deactivated in place. Never DELETE: a promotion
-- referenced by a historical sale must survive, which the RESTRICT
-- foreign key on sale_promotion_applications also enforces. Deactivation
-- (`is_active = false`) is the removal mechanism.
--
-- sale_promotion_applications: SELECT + INSERT ONLY. No UPDATE, no
-- DELETE - the same strictest grant as customer_points and
-- journal_entries. This is what makes promotion provenance append-only at
-- the DATABASE layer: a historical application can never be rewritten to
-- agree with a promotion that has since been edited.
--
-- NOTE on locking (the Phase 5 `sales` lesson, applied up front for the
-- fourth phase running): PostgreSQL requires the UPDATE privilege to run
-- SELECT ... FOR UPDATE. Neither table is ever row-locked by Phase 8D -
-- promotion resolution is a pure read inside the sale's existing
-- transaction, and with quotas/usage-limits deferred there is no counter
-- to contend on - so no locking-only grant is needed on either.

GRANT SELECT, INSERT, UPDATE ON "promotions" TO erp_app;
GRANT SELECT, INSERT ON "sale_promotion_applications" TO erp_app;
