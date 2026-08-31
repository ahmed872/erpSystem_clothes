-- Phase 10 (Exchanges): two new enum values, ALONE in their own migration.
--
-- PostgreSQL cannot USE a newly added enum value in the same transaction
-- that adds it (the lesson from Phase 8C's REDEMPTION_RESTORATION), and
-- the accounting mapping row that references EXCHANGE_CLEARING is written
-- by the application seed rather than by DDL, so nothing here may use
-- either value yet.
ALTER TYPE "SalePaymentMethod" ADD VALUE IF NOT EXISTS 'EXCHANGE_CREDIT';
ALTER TYPE "AccountingMappingKey" ADD VALUE IF NOT EXISTS 'EXCHANGE_CLEARING';
