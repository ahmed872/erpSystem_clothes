-- CreateTable
CREATE TABLE "expense_categories" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "expense_category_id" TEXT NOT NULL,
    "shift_id" TEXT,
    "expense_number" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "payment_method" "PurchasePaymentMethod" NOT NULL DEFAULT 'CASH',
    "reference" TEXT,
    "description" TEXT,
    "expense_date" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expense_categories_business_id_idx" ON "expense_categories"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_business_id_name_key" ON "expense_categories"("business_id", "name");

-- CreateIndex
CREATE INDEX "expenses_business_id_idx" ON "expenses"("business_id");

-- CreateIndex
CREATE INDEX "expenses_business_id_expense_date_idx" ON "expenses"("business_id", "expense_date");

-- CreateIndex
CREATE INDEX "expenses_expense_category_id_idx" ON "expenses"("expense_category_id");

-- CreateIndex
CREATE INDEX "expenses_shift_id_idx" ON "expenses"("shift_id");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_business_id_expense_number_key" ON "expenses"("business_id", "expense_number");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_business_id_idempotency_key_key" ON "expenses"("business_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_expense_category_id_fkey" FOREIGN KEY ("expense_category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------
-- Phase 10 (10H): RLS, grants and the invariants an expense must obey.
-- ---------------------------------------------------------------------

-- Categories: never DELETED, only deactivated. An expense already posted
-- against a category must stay explicable forever.
ALTER TABLE "expense_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "expense_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "expense_categories_tenant_isolation" ON "expense_categories"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON "expense_categories" TO erp_app;

-- Expenses: APPEND-ONLY. A financial event, and a mistaken one is
-- corrected by a compensating entry - never by editing the record of what
-- happened. Same posture as stock_movements, journal_entries and
-- cash_transactions.
ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "expenses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "expenses_tenant_isolation" ON "expenses"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));
GRANT SELECT, INSERT ON "expenses" TO erp_app;

-- A zero expense carries no information and a negative one is a refund
-- wearing the wrong name - neither is an expense.
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_amount_positive" CHECK (amount > 0);

-- A CASH expense left a drawer, so it names the shift it left. Anything
-- else did not, so it must not claim one: without this, an expense paid by
-- bank transfer could be attributed to a till and would then be counted as
-- a shortage at blind close - money the cashier never touched.
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_cash_requires_shift" CHECK (
    (payment_method = 'CASH' AND shift_id IS NOT NULL)
    OR (payment_method <> 'CASH' AND shift_id IS NULL)
  );
