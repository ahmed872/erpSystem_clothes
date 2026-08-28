-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupplierTransactionType" AS ENUM ('PURCHASE', 'PURCHASE_RETURN', 'PAYMENT', 'OPENING_BALANCE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PurchasePaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'OTHER');

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact_person" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "tax_number" TEXT,
    "payment_terms_days" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_transactions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "type" "SupplierTransactionType" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "description" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "purchase_number" TEXT NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'DRAFT',
    "order_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_date" TIMESTAMP(3),
    "notes" TEXT,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "cancelled_by" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_items" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "quantity_ordered" DECIMAL(18,4) NOT NULL,
    "quantity_received" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "quantity_returned" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "tax_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_receipts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "receipt_number" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "notes" TEXT,
    "received_by" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_receipt_items" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_receipt_id" TEXT NOT NULL,
    "purchase_item_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "quantity_received" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_receipt_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_returns" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "return_number" TEXT NOT NULL,
    "reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_return_items" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_return_id" TEXT NOT NULL,
    "purchase_item_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_payments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "method" "PurchasePaymentMethod" NOT NULL DEFAULT 'CASH',
    "reference" TEXT,
    "notes" TEXT,
    "paid_by" TEXT,
    "paid_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_business_id_idx" ON "suppliers"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_business_id_name_key" ON "suppliers"("business_id", "name");

-- CreateIndex
CREATE INDEX "supplier_transactions_business_id_idx" ON "supplier_transactions"("business_id");

-- CreateIndex
CREATE INDEX "supplier_transactions_supplier_id_idx" ON "supplier_transactions"("supplier_id");

-- CreateIndex
CREATE INDEX "supplier_transactions_reference_type_reference_id_idx" ON "supplier_transactions"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "purchases_business_id_idx" ON "purchases"("business_id");

-- CreateIndex
CREATE INDEX "purchases_branch_id_idx" ON "purchases"("branch_id");

-- CreateIndex
CREATE INDEX "purchases_warehouse_id_idx" ON "purchases"("warehouse_id");

-- CreateIndex
CREATE INDEX "purchases_supplier_id_idx" ON "purchases"("supplier_id");

-- CreateIndex
CREATE INDEX "purchases_status_idx" ON "purchases"("status");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_business_id_purchase_number_key" ON "purchases"("business_id", "purchase_number");

-- CreateIndex
CREATE INDEX "purchase_items_business_id_idx" ON "purchase_items"("business_id");

-- CreateIndex
CREATE INDEX "purchase_items_purchase_id_idx" ON "purchase_items"("purchase_id");

-- CreateIndex
CREATE INDEX "purchase_items_variant_id_idx" ON "purchase_items"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_items_purchase_id_variant_id_key" ON "purchase_items"("purchase_id", "variant_id");

-- CreateIndex
CREATE INDEX "purchase_receipts_business_id_idx" ON "purchase_receipts"("business_id");

-- CreateIndex
CREATE INDEX "purchase_receipts_purchase_id_idx" ON "purchase_receipts"("purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipts_business_id_idempotency_key_key" ON "purchase_receipts"("business_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "purchase_receipt_items_purchase_receipt_id_idx" ON "purchase_receipt_items"("purchase_receipt_id");

-- CreateIndex
CREATE INDEX "purchase_receipt_items_purchase_item_id_idx" ON "purchase_receipt_items"("purchase_item_id");

-- CreateIndex
CREATE INDEX "purchase_receipt_items_business_id_idx" ON "purchase_receipt_items"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipt_items_purchase_receipt_id_purchase_item_id_key" ON "purchase_receipt_items"("purchase_receipt_id", "purchase_item_id");

-- CreateIndex
CREATE INDEX "purchase_returns_business_id_idx" ON "purchase_returns"("business_id");

-- CreateIndex
CREATE INDEX "purchase_returns_purchase_id_idx" ON "purchase_returns"("purchase_id");

-- CreateIndex
CREATE INDEX "purchase_return_items_purchase_return_id_idx" ON "purchase_return_items"("purchase_return_id");

-- CreateIndex
CREATE INDEX "purchase_return_items_purchase_item_id_idx" ON "purchase_return_items"("purchase_item_id");

-- CreateIndex
CREATE INDEX "purchase_return_items_business_id_idx" ON "purchase_return_items"("business_id");

-- CreateIndex
CREATE INDEX "purchase_payments_business_id_idx" ON "purchase_payments"("business_id");

-- CreateIndex
CREATE INDEX "purchase_payments_purchase_id_idx" ON "purchase_payments"("purchase_id");

-- CreateIndex
CREATE INDEX "purchase_payments_supplier_id_idx" ON "purchase_payments"("supplier_id");

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_transactions" ADD CONSTRAINT "supplier_transactions_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_transactions" ADD CONSTRAINT "supplier_transactions_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_items" ADD CONSTRAINT "purchase_receipt_items_purchase_receipt_id_fkey" FOREIGN KEY ("purchase_receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_items" ADD CONSTRAINT "purchase_receipt_items_purchase_item_id_fkey" FOREIGN KEY ("purchase_item_id") REFERENCES "purchase_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_items" ADD CONSTRAINT "purchase_receipt_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_items" ADD CONSTRAINT "purchase_receipt_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_purchase_return_id_fkey" FOREIGN KEY ("purchase_return_id") REFERENCES "purchase_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_purchase_item_id_fkey" FOREIGN KEY ("purchase_item_id") REFERENCES "purchase_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint: business-rule integrity, defense in depth alongside
-- application-level validation (Phase 4 rule #10: no operation may leave
-- inventory/document state inconsistent).
ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_payment_terms_nonneg" CHECK ("payment_terms_days" IS NULL OR "payment_terms_days" >= 0);

ALTER TABLE "supplier_transactions"
  ADD CONSTRAINT "supplier_transactions_amount_nonzero" CHECK ("amount" <> 0);

ALTER TABLE "purchases"
  ADD CONSTRAINT "purchases_subtotal_nonneg" CHECK ("subtotal" >= 0),
  ADD CONSTRAINT "purchases_tax_amount_nonneg" CHECK ("tax_amount" >= 0),
  ADD CONSTRAINT "purchases_discount_amount_nonneg" CHECK ("discount_amount" >= 0),
  ADD CONSTRAINT "purchases_total_amount_nonneg" CHECK ("total_amount" >= 0);

-- The core over-receiving / over-returning guards (Phase 4 rule #9):
-- these are DEFENSE IN DEPTH on top of the application-level row lock +
-- check in the receiving/return use-cases, not a substitute for it - a
-- CHECK constraint alone cannot serialize concurrent transactions, but it
-- guarantees the invariant can never be violated even by a future bug.
ALTER TABLE "purchase_items"
  ADD CONSTRAINT "purchase_items_quantity_ordered_positive" CHECK ("quantity_ordered" > 0),
  ADD CONSTRAINT "purchase_items_quantity_received_nonneg" CHECK ("quantity_received" >= 0),
  ADD CONSTRAINT "purchase_items_quantity_returned_nonneg" CHECK ("quantity_returned" >= 0),
  ADD CONSTRAINT "purchase_items_received_not_over_ordered" CHECK ("quantity_received" <= "quantity_ordered"),
  ADD CONSTRAINT "purchase_items_returned_not_over_received" CHECK ("quantity_returned" <= "quantity_received"),
  ADD CONSTRAINT "purchase_items_unit_cost_nonneg" CHECK ("unit_cost" >= 0),
  ADD CONSTRAINT "purchase_items_tax_amount_nonneg" CHECK ("tax_amount" >= 0),
  ADD CONSTRAINT "purchase_items_discount_amount_nonneg" CHECK ("discount_amount" >= 0),
  ADD CONSTRAINT "purchase_items_line_total_nonneg" CHECK ("line_total" >= 0);

ALTER TABLE "purchase_receipt_items"
  ADD CONSTRAINT "purchase_receipt_items_quantity_received_positive" CHECK ("quantity_received" > 0),
  ADD CONSTRAINT "purchase_receipt_items_unit_cost_nonneg" CHECK ("unit_cost" >= 0);

ALTER TABLE "purchase_return_items"
  ADD CONSTRAINT "purchase_return_items_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "purchase_return_items_unit_cost_nonneg" CHECK ("unit_cost" >= 0);

ALTER TABLE "purchase_payments"
  ADD CONSTRAINT "purchase_payments_amount_positive" CHECK ("amount" > 0);
