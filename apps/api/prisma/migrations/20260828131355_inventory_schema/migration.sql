-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('OPENING_BALANCE', 'PURCHASE', 'SALE', 'SALES_RETURN', 'PURCHASE_RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'STOCK_COUNT', 'ADJUSTMENT', 'DAMAGE', 'LOSS', 'INTERNAL_CONSUMPTION', 'EXPIRY', 'BUNDLE_CONSUMPTION', 'AUTHORIZED_CORRECTION');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('DRAFT', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SerialNumberStatus" AS ENUM ('IN_STOCK', 'RESERVED', 'SOLD', 'DAMAGED', 'RETURNED');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "tracks_lots" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tracks_serial_numbers" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "movement_type" "StockMovementType" NOT NULL,
    "quantity_base" DECIMAL(18,4) NOT NULL,
    "uom_id" TEXT,
    "quantity_in_uom" DECIMAL(18,4),
    "unit_cost_at_movement" DECIMAL(18,4) NOT NULL,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "lot_id" TEXT,
    "is_negative_stock" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "quantity_on_hand" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "quantity_reserved" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "average_cost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_lots" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "lot_number" TEXT NOT NULL,
    "manufacturing_date" TIMESTAMP(3),
    "expiry_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serial_numbers" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "status" "SerialNumberStatus" NOT NULL DEFAULT 'IN_STOCK',
    "current_warehouse_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "serial_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_counts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_items" (
    "id" TEXT NOT NULL,
    "stock_count_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "expected_quantity" DECIMAL(18,4) NOT NULL,
    "actual_quantity" DECIMAL(18,4),
    "reason" TEXT,

    CONSTRAINT "stock_count_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "source_warehouse_id" TEXT NOT NULL,
    "destination_warehouse_id" TEXT NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by" TEXT,
    "sent_by" TEXT,
    "sent_at" TIMESTAMP(3),
    "received_by" TEXT,
    "received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_items" (
    "id" TEXT NOT NULL,
    "stock_transfer_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "quantity_received" DECIMAL(18,4),

    CONSTRAINT "stock_transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_movements_business_id_idx" ON "stock_movements"("business_id");

-- CreateIndex
CREATE INDEX "stock_movements_warehouse_id_variant_id_idx" ON "stock_movements"("warehouse_id", "variant_id");

-- CreateIndex
CREATE INDEX "stock_movements_variant_id_idx" ON "stock_movements"("variant_id");

-- CreateIndex
CREATE INDEX "stock_movements_reference_type_reference_id_idx" ON "stock_movements"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "stock_movements_movement_type_idx" ON "stock_movements"("movement_type");

-- CreateIndex
CREATE INDEX "stock_movements_created_at_idx" ON "stock_movements"("created_at");

-- CreateIndex
CREATE INDEX "stock_balances_business_id_idx" ON "stock_balances"("business_id");

-- CreateIndex
CREATE INDEX "stock_balances_variant_id_idx" ON "stock_balances"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_business_id_warehouse_id_variant_id_key" ON "stock_balances"("business_id", "warehouse_id", "variant_id");

-- CreateIndex
CREATE INDEX "inventory_lots_business_id_idx" ON "inventory_lots"("business_id");

-- CreateIndex
CREATE INDEX "inventory_lots_expiry_date_idx" ON "inventory_lots"("expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_lots_business_id_variant_id_lot_number_key" ON "inventory_lots"("business_id", "variant_id", "lot_number");

-- CreateIndex
CREATE INDEX "serial_numbers_business_id_idx" ON "serial_numbers"("business_id");

-- CreateIndex
CREATE INDEX "serial_numbers_variant_id_idx" ON "serial_numbers"("variant_id");

-- CreateIndex
CREATE INDEX "serial_numbers_status_idx" ON "serial_numbers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "serial_numbers_business_id_serial_key" ON "serial_numbers"("business_id", "serial");

-- CreateIndex
CREATE INDEX "stock_counts_business_id_idx" ON "stock_counts"("business_id");

-- CreateIndex
CREATE INDEX "stock_counts_warehouse_id_idx" ON "stock_counts"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_items_stock_count_id_variant_id_key" ON "stock_count_items"("stock_count_id", "variant_id");

-- CreateIndex
CREATE INDEX "stock_transfers_business_id_idx" ON "stock_transfers"("business_id");

-- CreateIndex
CREATE INDEX "stock_transfers_source_warehouse_id_idx" ON "stock_transfers"("source_warehouse_id");

-- CreateIndex
CREATE INDEX "stock_transfers_destination_warehouse_id_idx" ON "stock_transfers"("destination_warehouse_id");

-- CreateIndex
CREATE INDEX "stock_transfers_status_idx" ON "stock_transfers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_items_stock_transfer_id_variant_id_key" ON "stock_transfer_items"("stock_transfer_id", "variant_id");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "uoms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "inventory_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_current_warehouse_id_fkey" FOREIGN KEY ("current_warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_items" ADD CONSTRAINT "stock_count_items_stock_count_id_fkey" FOREIGN KEY ("stock_count_id") REFERENCES "stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_items" ADD CONSTRAINT "stock_count_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_source_warehouse_id_fkey" FOREIGN KEY ("source_warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_destination_warehouse_id_fkey" FOREIGN KEY ("destination_warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_stock_transfer_id_fkey" FOREIGN KEY ("stock_transfer_id") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Extra integrity constraints Prisma's schema DSL cannot express directly.
-- ============================================================================

-- Movements can never carry a zero quantity (that's not a movement at
-- all) - direction is encoded in the sign.
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_quantity_nonzero" CHECK ("quantity_base" <> 0),
  ADD CONSTRAINT "stock_movements_unit_cost_nonneg" CHECK ("unit_cost_at_movement" >= 0);

-- A cached balance's average cost is never negative (quantity CAN go
-- negative when negative-inventory is explicitly enabled - see
-- resolveAllowNegative in application code - but cost never can).
ALTER TABLE "stock_balances"
  ADD CONSTRAINT "stock_balances_avg_cost_nonneg" CHECK ("average_cost" >= 0),
  ADD CONSTRAINT "stock_balances_reserved_nonneg" CHECK ("quantity_reserved" >= 0);

ALTER TABLE "stock_count_items"
  ADD CONSTRAINT "stock_count_items_expected_nonneg" CHECK ("expected_quantity" >= 0),
  ADD CONSTRAINT "stock_count_items_actual_nonneg" CHECK ("actual_quantity" IS NULL OR "actual_quantity" >= 0);

ALTER TABLE "stock_transfer_items"
  ADD CONSTRAINT "stock_transfer_items_qty_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "stock_transfer_items_received_nonneg" CHECK ("quantity_received" IS NULL OR "quantity_received" >= 0);

-- A transfer's source and destination warehouse can never be the same.
ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_source_ne_destination" CHECK ("source_warehouse_id" <> "destination_warehouse_id");
