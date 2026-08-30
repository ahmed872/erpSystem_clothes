-- Phase 8C. Deliberately a SEPARATE migration from the ALTER TYPE that
-- added 'REDEMPTION_RESTORATION': PostgreSQL forbids USING a newly added
-- enum value in the same transaction that added it, and Prisma runs each
-- migration file in its own transaction. Splitting them is what makes
-- the CHECK below legal.

-- ---------------------------------------------------------------------------
-- 1. Extend sign discipline to the new event type.
-- ---------------------------------------------------------------------------
-- REDEMPTION_RESTORATION hands a customer back points they previously
-- spent, so it is strictly positive - the mirror of REDEEM. Without this
-- the new value would be the only type in the enum whose sign the
-- database did not police, and a negative "restoration" would silently
-- take points away while reading as a refund.
ALTER TABLE "customer_points" DROP CONSTRAINT "customer_points_sign_matches_type";

ALTER TABLE "customer_points"
  ADD CONSTRAINT "customer_points_sign_matches_type" CHECK (
    ("type" = 'EARN' AND "points" > 0)
    OR ("type" = 'REDEEM' AND "points" < 0)
    OR ("type" = 'RETURN_CLAWBACK' AND "points" < 0)
    OR ("type" = 'REDEMPTION_RESTORATION' AND "points" > 0)
    OR ("type" = 'ADJUSTMENT')
  );

-- ---------------------------------------------------------------------------
-- 2. The real duplicate-event backstop for machine-generated rows.
-- ---------------------------------------------------------------------------
-- `customer_points_business_id_idempotency_key_key` does NOT cover these
-- rows: `Sale.idempotencyKey` is OPTIONAL, so a sale created without one
-- produces ledger rows with a NULL key, and PostgreSQL permits unlimited
-- NULLs in a UNIQUE index. This partial index is therefore the only
-- database-level guarantee that:
--
--   one Sale        -> at most one EARN   and at most one REDEEM
--   one SaleReturn  -> at most one RETURN_CLAWBACK
--                      and at most one REDEMPTION_RESTORATION
--
-- It is the final backstop behind the application's own idempotency
-- checks, exactly as `journal_entries (business_id, source_type,
-- source_id)` is for double-posting (Phase 6): under true concurrency the
-- database, not the pre-check, is what resolves the race.
--
-- Manual ADJUSTMENT rows carry no reference and are excluded by the WHERE
-- clause - they are deduplicated by their own required idempotencyKey.
CREATE UNIQUE INDEX "customer_points_one_event_per_source"
  ON "customer_points" ("business_id", "reference_type", "reference_id", "type")
  WHERE "reference_type" IS NOT NULL;
