-- CreateEnum
CREATE TYPE "TaxPricingMode" AS ENUM ('EXCLUSIVE', 'INCLUSIVE');

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "default_tax_id" TEXT,
ADD COLUMN     "tax_pricing_mode" "TaxPricingMode" NOT NULL DEFAULT 'EXCLUSIVE';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "tax_exempt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tax_id" TEXT;

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "tax_exempt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tax_id" TEXT,
ADD COLUMN     "tax_rate_snapshot" DECIMAL(9,4);

-- CreateTable
CREATE TABLE "taxes" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate_percent" DECIMAL(9,4) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "taxes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "taxes_business_id_idx" ON "taxes"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "taxes_business_id_name_key" ON "taxes"("business_id", "name");

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_default_tax_id_fkey" FOREIGN KEY ("default_tax_id") REFERENCES "taxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tax_id_fkey" FOREIGN KEY ("tax_id") REFERENCES "taxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxes" ADD CONSTRAINT "taxes_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tax_id_fkey" FOREIGN KEY ("tax_id") REFERENCES "taxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 10 (BD-18) integrity.
-- A rate is a percentage and is never negative. 100% is permitted (some
-- jurisdictions levy duties at or above the item value) but a rate above
-- 1000% is far more likely a data-entry slip than a real tax.
ALTER TABLE "taxes"
  ADD CONSTRAINT "taxes_rate_percent_range" CHECK ("rate_percent" >= 0 AND "rate_percent" <= 1000);

-- The snapshot is all-or-nothing and carries the same range: a line either
-- records the rate that produced its tax, or records no rate at all.
ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_tax_rate_snapshot_range" CHECK (
    "tax_rate_snapshot" IS NULL OR ("tax_rate_snapshot" >= 0 AND "tax_rate_snapshot" <= 1000)
  );
