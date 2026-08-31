-- Phase 10 (BD-22): the disposition decided for each returned physical
-- unit, recorded permanently on the return link.
--
-- The serial's own row only ever holds its CURRENT status, and that
-- changes the next time the unit is sold. This column is the permanent
-- record of what was decided when the customer handed it over.
--
-- DEFAULT SELLABLE backfills the Phase 8E rows truthfully: every return
-- written under 8E named a line condition, and SELLABLE was the only
-- disposition that path could produce for a serial (the unit went to the
-- RETURNED quarantine state regardless of the line's condition - which is
-- precisely the defect BD-22 corrects). Those historical rows are NOT
-- rewritten: their serials keep the RETURNED status they were given, and
-- the enum value is retained rather than dropped for exactly that reason.
ALTER TABLE "sale_return_item_serials"
  ADD COLUMN "condition" "SaleReturnCondition" NOT NULL DEFAULT 'SELLABLE';
