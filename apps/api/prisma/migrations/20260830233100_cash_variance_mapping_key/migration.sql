-- Phase 10 (BD-17 rule 8): the configurable account key a blind-close cash
-- variance posts to.
--
-- Deliberately isolated in its own migration: PostgreSQL forbids USING a
-- newly added enum value in the same transaction that adds it. Nothing in
-- this migration uses the value; the next migration and the runtime seed
-- may. This is the Phase 8C lesson (REDEMPTION_RESTORATION) carried forward
-- as standing practice rather than re-learned.
ALTER TYPE "AccountingMappingKey" ADD VALUE 'CASH_VARIANCE';
