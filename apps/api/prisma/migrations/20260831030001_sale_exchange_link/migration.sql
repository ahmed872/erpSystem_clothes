-- Phase 10 (Exchanges): the replacement sale points at the return it
-- replaces.
--
-- The link points this way round because the return is created FIRST: its
-- credit is what decides how the replacement may be settled. A column on
-- the return could only ever be filled in afterwards, and `sale_returns`
-- is append-only by grant, so there is nothing to fill it in with.
--
-- ON DELETE RESTRICT: neither half of an exchange can be removed while the
-- other still points at it. Nothing in the application deletes either, so
-- this is a backstop, not a workflow.
ALTER TABLE "sales" ADD COLUMN "exchange_for_return_id" TEXT;

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_exchange_for_return_id_fkey"
  FOREIGN KEY ("exchange_for_return_id") REFERENCES "sale_returns"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "sales_exchange_for_return_id_idx" ON "sales"("exchange_for_return_id");
