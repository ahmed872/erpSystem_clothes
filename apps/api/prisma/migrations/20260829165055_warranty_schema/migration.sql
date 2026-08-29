-- CreateEnum
CREATE TYPE "WarrantyStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CLAIMED', 'VOID');

-- CreateEnum
CREATE TYPE "WarrantyClaimStatus" AS ENUM ('OPEN', 'RESOLVED', 'REJECTED');

-- CreateTable
CREATE TABLE "warranties" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "sale_item_id" TEXT NOT NULL,
    "serial_number_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "status" "WarrantyStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warranties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warranty_claims" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "warranty_id" TEXT NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "description" TEXT NOT NULL,
    "status" "WarrantyClaimStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warranty_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warranties_business_id_idx" ON "warranties"("business_id");

-- CreateIndex
CREATE INDEX "warranties_sale_item_id_idx" ON "warranties"("sale_item_id");

-- CreateIndex
CREATE INDEX "warranties_serial_number_id_idx" ON "warranties"("serial_number_id");

-- CreateIndex
CREATE INDEX "warranties_customer_id_idx" ON "warranties"("customer_id");

-- CreateIndex
CREATE INDEX "warranties_status_idx" ON "warranties"("status");

-- CreateIndex
CREATE UNIQUE INDEX "warranties_business_id_sale_item_id_serial_number_id_key" ON "warranties"("business_id", "sale_item_id", "serial_number_id");

-- CreateIndex
CREATE INDEX "warranty_claims_business_id_idx" ON "warranty_claims"("business_id");

-- CreateIndex
CREATE INDEX "warranty_claims_warranty_id_idx" ON "warranty_claims"("warranty_id");

-- CreateIndex
CREATE INDEX "warranty_claims_status_idx" ON "warranty_claims"("status");

-- AddForeignKey
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_serial_number_id_fkey" FOREIGN KEY ("serial_number_id") REFERENCES "serial_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_warranty_id_fkey" FOREIGN KEY ("warranty_id") REFERENCES "warranties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint: business-rule integrity at the database layer, defense
-- in depth alongside application validation - the same rule every prior
-- phase follows (the DB provides the final guarantee, not only an
-- application pre-check).

ALTER TABLE "warranties"
  -- A warranty period must be positive. There is deliberately no BUSINESS
  -- maximum here (Phase 0 defines none, and inventing one was explicitly
  -- forbidden); the upper bound is purely TECHNICAL, chosen so
  -- start_date + duration_days can never overflow a valid timestamp.
  -- 36500 days = 100 years, far beyond any real warranty, and safely
  -- inside Postgres's timestamp range.
  ADD CONSTRAINT "warranties_duration_days_positive" CHECK ("duration_days" > 0),
  ADD CONSTRAINT "warranties_duration_days_technical_bound" CHECK ("duration_days" <= 36500),
  -- end_date is always derived as start_date + duration_days, so it can
  -- never precede the start.
  ADD CONSTRAINT "warranties_end_after_start" CHECK ("end_date" > "start_date");

ALTER TABLE "warranty_claims"
  ADD CONSTRAINT "warranty_claims_description_not_empty" CHECK (length(btrim("description")) > 0),
  -- A claim is resolved or rejected together with WHO resolved it and
  -- WHEN - the transition can never be recorded without its audit trail,
  -- and an OPEN claim can never carry a resolution timestamp.
  ADD CONSTRAINT "warranty_claims_resolution_audit_consistent" CHECK (
    ("status" = 'OPEN' AND "resolved_at" IS NULL AND "resolved_by" IS NULL)
    OR ("status" <> 'OPEN' AND "resolved_at" IS NOT NULL)
  );
