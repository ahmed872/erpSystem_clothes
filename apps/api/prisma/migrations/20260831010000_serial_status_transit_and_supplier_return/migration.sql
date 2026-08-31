-- Phase 10 (10D): two new serial lifecycle states.
--
-- Deliberately ALONE in its own migration. PostgreSQL cannot USE a newly
-- added enum value in the same transaction that adds it (the lesson from
-- Phase 8C's REDEMPTION_RESTORATION), so the tables and code that depend
-- on these values live in the migration that follows.
ALTER TYPE "SerialNumberStatus" ADD VALUE IF NOT EXISTS 'IN_TRANSIT';
ALTER TYPE "SerialNumberStatus" ADD VALUE IF NOT EXISTS 'RETURNED_TO_SUPPLIER';
