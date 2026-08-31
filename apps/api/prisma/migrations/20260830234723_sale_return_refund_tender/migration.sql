-- AlterTable
ALTER TABLE "sale_returns" ADD COLUMN     "refund_amount" DECIMAL(18,4),
ADD COLUMN     "refund_method" "SalePaymentMethod",
ADD COLUMN     "refund_reference" TEXT;

-- Phase 10 (BD-23) integrity: the refund tender is all-or-nothing, and a
-- refund is a real, positive movement of money. A zero or negative refund
-- is not a refund.
ALTER TABLE "sale_returns"
  ADD CONSTRAINT "sale_returns_refund_all_or_nothing" CHECK (
    ("refund_method" IS NULL AND "refund_amount" IS NULL)
    OR ("refund_method" IS NOT NULL AND "refund_amount" IS NOT NULL AND "refund_amount" > 0)
  );
