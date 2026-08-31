-- CreateEnum
CREATE TYPE "CashTransactionType" AS ENUM ('SALE_TENDER', 'SALE_REFUND', 'PAY_IN', 'PAY_OUT', 'EXPENSE');

-- AlterTable
ALTER TABLE "shifts" ADD COLUMN     "cash_register_id" TEXT,
ADD COLUMN     "counted_cash" DECIMAL(18,4),
ADD COLUMN     "opening_float" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "reconciled_at" TIMESTAMP(3),
ADD COLUMN     "reconciled_by" TEXT,
ADD COLUMN     "reconciliation_note" TEXT;

-- CreateTable
CREATE TABLE "cash_registers" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_transactions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "type" "CashTransactionType" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_registers_business_id_idx" ON "cash_registers"("business_id");

-- CreateIndex
CREATE INDEX "cash_registers_business_id_branch_id_idx" ON "cash_registers"("business_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_registers_business_id_code_key" ON "cash_registers"("business_id", "code");

-- CreateIndex
CREATE INDEX "cash_transactions_business_id_idx" ON "cash_transactions"("business_id");

-- CreateIndex
CREATE INDEX "cash_transactions_business_id_shift_id_idx" ON "cash_transactions"("business_id", "shift_id");

-- CreateIndex
CREATE INDEX "cash_transactions_business_id_reference_type_reference_id_idx" ON "cash_transactions"("business_id", "reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "shifts_business_id_cash_register_id_idx" ON "shifts"("business_id", "cash_register_id");

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_cash_register_id_fkey" FOREIGN KEY ("cash_register_id") REFERENCES "cash_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- Phase 10 (BD-17) integrity constraints
-- ---------------------------------------------------------------------

-- A cash movement is never zero, and its sign must agree with its type.
-- Money into the drawer is positive; money out is negative. Enforcing this
-- at the database means a mis-signed insert is impossible rather than
-- merely unlikely, which is what keeps derived expected-cash trustworthy.
ALTER TABLE "cash_transactions"
  ADD CONSTRAINT "cash_transactions_amount_nonzero" CHECK ("amount" <> 0),
  ADD CONSTRAINT "cash_transactions_amount_sign_matches_type" CHECK (
    ("type" IN ('SALE_TENDER', 'PAY_IN') AND "amount" > 0)
    OR ("type" IN ('SALE_REFUND', 'PAY_OUT', 'EXPENSE') AND "amount" < 0)
  );

-- The opening float and the counted cash are physical quantities of money:
-- neither can be negative. countedCash stays NULL until the shift closes.
ALTER TABLE "shifts"
  ADD CONSTRAINT "shifts_opening_float_nonneg" CHECK ("opening_float" >= 0),
  ADD CONSTRAINT "shifts_counted_cash_nonneg" CHECK ("counted_cash" IS NULL OR "counted_cash" >= 0),
  -- A closed shift always carries its counted amount; an open one never
  -- does. This is what makes "blind close wrote exactly once" checkable.
  ADD CONSTRAINT "shifts_counted_cash_matches_status" CHECK (
    ("status" = 'OPEN' AND "counted_cash" IS NULL)
    OR ("status" = 'CLOSED' AND "counted_cash" IS NOT NULL)
  ),
  -- Reconciliation is an acknowledgement: both fields move together, and
  -- only a closed shift can carry them.
  ADD CONSTRAINT "shifts_reconciliation_all_or_nothing" CHECK (
    ("reconciled_by" IS NULL AND "reconciled_at" IS NULL)
    OR ("reconciled_by" IS NOT NULL AND "reconciled_at" IS NOT NULL AND "status" = 'CLOSED')
  );

-- BD-17 rule 10: one active shift per cash register. A partial unique index
-- rather than an application check, so a genuine race cannot produce two.
-- Shifts opened before Phase 10 have a NULL register and are exempt, which
-- is exactly right: NULLs never conflict in a unique index.
CREATE UNIQUE INDEX "shifts_one_open_per_register"
  ON "shifts" ("business_id", "cash_register_id")
  WHERE "status" = 'OPEN' AND "cash_register_id" IS NOT NULL;
