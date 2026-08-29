-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "NormalBalance" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "JournalEntryStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "FiscalPeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "AccountingMappingKey" AS ENUM ('SALES_REVENUE', 'COGS', 'INVENTORY_ASSET', 'ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'TAX_PAYABLE', 'INVENTORY_SHRINKAGE', 'INVENTORY_GAIN', 'INTERNAL_CONSUMPTION_EXPENSE', 'TENDER_CASH', 'TENDER_CARD', 'TENDER_WALLET', 'TENDER_BANK_TRANSFER', 'TENDER_CHEQUE', 'TENDER_OTHER');

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "normal_balance" "NormalBalance" NOT NULL,
    "parent_account_id" TEXT,
    "is_system_account" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_periods" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "status" "FiscalPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "closed_by" TEXT,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "fiscal_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_mapping_rules" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "key" "AccountingMappingKey" NOT NULL,
    "account_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_mapping_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "fiscal_period_id" TEXT NOT NULL,
    "entry_number" TEXT NOT NULL,
    "entry_date" TIMESTAMP(3) NOT NULL,
    "status" "JournalEntryStatus" NOT NULL DEFAULT 'POSTED',
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "reversal_of_id" TEXT,
    "description" TEXT,
    "posted_by" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entry_lines" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "journal_entry_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "debit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entry_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounts_business_id_idx" ON "accounts"("business_id");

-- CreateIndex
CREATE INDEX "accounts_parent_account_id_idx" ON "accounts"("parent_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_business_id_code_key" ON "accounts"("business_id", "code");

-- CreateIndex
CREATE INDEX "fiscal_periods_business_id_idx" ON "fiscal_periods"("business_id");

-- CreateIndex
CREATE INDEX "accounting_mapping_rules_business_id_idx" ON "accounting_mapping_rules"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_mapping_rules_business_id_key_key" ON "accounting_mapping_rules"("business_id", "key");

-- CreateIndex
CREATE INDEX "journal_entries_business_id_idx" ON "journal_entries"("business_id");

-- CreateIndex
CREATE INDEX "journal_entries_fiscal_period_id_idx" ON "journal_entries"("fiscal_period_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_business_id_source_type_source_id_key" ON "journal_entries"("business_id", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_business_id_entry_number_key" ON "journal_entries"("business_id", "entry_number");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_business_id_reversal_of_id_key" ON "journal_entries"("business_id", "reversal_of_id");

-- CreateIndex
CREATE INDEX "journal_entry_lines_business_id_idx" ON "journal_entry_lines"("business_id");

-- CreateIndex
CREATE INDEX "journal_entry_lines_journal_entry_id_idx" ON "journal_entry_lines"("journal_entry_id");

-- CreateIndex
CREATE INDEX "journal_entry_lines_account_id_idx" ON "journal_entry_lines"("account_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_account_id_fkey" FOREIGN KEY ("parent_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_mapping_rules" ADD CONSTRAINT "accounting_mapping_rules_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_mapping_rules" ADD CONSTRAINT "accounting_mapping_rules_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_fiscal_period_id_fkey" FOREIGN KEY ("fiscal_period_id") REFERENCES "fiscal_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint: business-rule integrity, defense in depth alongside
-- AccountingEngine.postEntry's own application-level validation (Phase 0
-- §6.1: the DB must provide the final safety guarantee, not only an
-- application pre-check - the same rule every prior phase's CHECK
-- constraints already follow).
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_parent_not_self" CHECK ("parent_account_id" IS NULL OR "parent_account_id" <> "id");

ALTER TABLE "fiscal_periods"
  ADD CONSTRAINT "fiscal_periods_end_after_start" CHECK ("end_date" > "start_date");

-- Each line is either a debit or a credit, never both, never neither -
-- the row-level half of the double-entry invariant. The aggregate half
-- (SUM(debit) = SUM(credit) per journal_entry_id) cannot be expressed as
-- a plain CHECK (Postgres CHECK constraints cannot reference other rows),
-- so it is enforced by the DEFERRED constraint trigger below instead -
-- the second line of defense behind AccountingEngine.postEntry's own
-- pre-insert balance check.
ALTER TABLE "journal_entry_lines"
  ADD CONSTRAINT "journal_entry_lines_debit_nonneg" CHECK ("debit" >= 0),
  ADD CONSTRAINT "journal_entry_lines_credit_nonneg" CHECK ("credit" >= 0),
  ADD CONSTRAINT "journal_entry_lines_debit_xor_credit" CHECK (
    ("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0)
  );

-- Deferred constraint trigger: re-verifies SUM(debit) = SUM(credit) for
-- the affected journal_entry_id at TRANSACTION-COMMIT time (DEFERRABLE
-- INITIALLY DEFERRED), not per-row - AccountingEngine.postEntry inserts
-- a journal entry's lines one at a time within one transaction, so a
-- per-row/immediate check would reject the first (necessarily unbalanced
-- on its own) line every time. This should never actually fire in normal
-- operation, since postEntry always validates the balance in application
-- code BEFORE inserting anything - it exists purely as the DB-level
-- backstop Phase 0 §6.1 requires, verified directly by a test that
-- inserts an unbalanced set of lines via raw SQL as the erp_app role
-- (bypassing the application layer entirely) and confirms rejection.
CREATE OR REPLACE FUNCTION check_journal_entry_balanced() RETURNS trigger AS $$
DECLARE
  affected_entry_id TEXT;
  total_debit NUMERIC;
  total_credit NUMERIC;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_entry_id := OLD.journal_entry_id;
  ELSE
    affected_entry_id := NEW.journal_entry_id;
  END IF;

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_debit, total_credit
    FROM journal_entry_lines
    WHERE journal_entry_id = affected_entry_id;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Journal entry % is not balanced: total debit=%, total credit=%', affected_entry_id, total_debit, total_credit
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_entry_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_entry_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_entry_balanced();
