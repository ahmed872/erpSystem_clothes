-- CreateEnum
CREATE TYPE "HeldSaleStatus" AS ENUM ('OPEN', 'RESUMED', 'VOIDED');

-- CreateTable
CREATE TABLE "held_sales" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "shift_id" TEXT NOT NULL,
    "hold_number" TEXT NOT NULL,
    "status" "HeldSaleStatus" NOT NULL DEFAULT 'OPEN',
    "label" TEXT,
    "notes" TEXT,
    "resumed_sale_id" TEXT,
    "resumed_at" TIMESTAMP(3),
    "resumed_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,
    "void_reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "held_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "held_sale_items" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "held_sale_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "discount_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tax_exempt" BOOLEAN NOT NULL DEFAULT false,
    "serials" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "held_sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "held_sales_business_id_idx" ON "held_sales"("business_id");

-- CreateIndex
CREATE INDEX "held_sales_business_id_status_idx" ON "held_sales"("business_id", "status");

-- CreateIndex
CREATE INDEX "held_sales_shift_id_idx" ON "held_sales"("shift_id");

-- CreateIndex
CREATE INDEX "held_sales_warehouse_id_idx" ON "held_sales"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "held_sales_business_id_hold_number_key" ON "held_sales"("business_id", "hold_number");

-- CreateIndex
CREATE INDEX "held_sale_items_business_id_idx" ON "held_sale_items"("business_id");

-- CreateIndex
CREATE INDEX "held_sale_items_held_sale_id_idx" ON "held_sale_items"("held_sale_id");

-- AddForeignKey
ALTER TABLE "held_sales" ADD CONSTRAINT "held_sales_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_sales" ADD CONSTRAINT "held_sales_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_sales" ADD CONSTRAINT "held_sales_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_sales" ADD CONSTRAINT "held_sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_sales" ADD CONSTRAINT "held_sales_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_sales" ADD CONSTRAINT "held_sales_resumed_sale_id_fkey" FOREIGN KEY ("resumed_sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_sale_items" ADD CONSTRAINT "held_sale_items_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_sale_items" ADD CONSTRAINT "held_sale_items_held_sale_id_fkey" FOREIGN KEY ("held_sale_id") REFERENCES "held_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_sale_items" ADD CONSTRAINT "held_sale_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------
-- Phase 10 (BLOCKING-2): RLS, grants and the invariants a parked basket
-- must obey.
--
-- NOT append-only, deliberately, and the only Phase-10 table that isn't:
-- a held basket is a DRAFT. Editing one before checkout is the entire
-- point, and its terminal states (RESUMED / VOIDED) are recorded on the
-- row rather than as a second document, because a basket that was never
-- bought is not an event anybody needs a ledger of. DELETE is still
-- withheld: a hold that was parked and abandoned is a real thing that
-- happened at that till, and staff should be able to see it.
-- ---------------------------------------------------------------------

ALTER TABLE "held_sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "held_sales" FORCE ROW LEVEL SECURITY;
CREATE POLICY "held_sales_tenant_isolation" ON "held_sales"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON "held_sales" TO erp_app;

ALTER TABLE "held_sale_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "held_sale_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "held_sale_items_tenant_isolation" ON "held_sale_items"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));
-- DELETE is granted here and NOWHERE else in the schema: replacing a
-- basket's lines is how a cashier edits it, and a line removed from a
-- draft nobody has bought is not history being rewritten.
GRANT SELECT, INSERT, UPDATE, DELETE ON "held_sale_items" TO erp_app;

-- A quantity or price of zero on a parked line is a data-entry slip, not a
-- basket, and a negative one is nonsense.
ALTER TABLE "held_sale_items"
  ADD CONSTRAINT "held_sale_items_quantity_positive" CHECK (quantity > 0);
ALTER TABLE "held_sale_items"
  ADD CONSTRAINT "held_sale_items_unit_price_nonneg" CHECK (unit_price >= 0);
ALTER TABLE "held_sale_items"
  ADD CONSTRAINT "held_sale_items_discount_nonneg" CHECK (discount_amount >= 0);

-- The terminal states carry their evidence or they did not happen. An
-- OPEN hold has neither; a RESUMED one names the sale it became; a VOIDED
-- one names when it was abandoned.
ALTER TABLE "held_sales"
  ADD CONSTRAINT "held_sales_resumed_all_or_nothing" CHECK (
    (status = 'RESUMED' AND resumed_sale_id IS NOT NULL AND resumed_at IS NOT NULL)
    OR (status <> 'RESUMED' AND resumed_sale_id IS NULL AND resumed_at IS NULL)
  );
ALTER TABLE "held_sales"
  ADD CONSTRAINT "held_sales_voided_all_or_nothing" CHECK (
    (status = 'VOIDED' AND voided_at IS NOT NULL)
    OR (status <> 'VOIDED' AND voided_at IS NULL)
  );

-- Reservation is ADVISORY, but it may never go negative: that would mean
-- more was released than was ever held, and the "available" figure staff
-- read off the shelf would be a lie in the unsafe direction.
ALTER TABLE "stock_balances"
  ADD CONSTRAINT "stock_balances_quantity_reserved_nonneg" CHECK (quantity_reserved >= 0);
