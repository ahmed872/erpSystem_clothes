-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('SIMPLE', 'BUNDLE');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "ProductVariantStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PriceChangeType" AS ENUM ('COST', 'SELLING_PRICE', 'LIST_PRICE');

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uoms" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "precision" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "uoms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_attributes" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_attribute_values" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "attribute_id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_attribute_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "alternative_name" TEXT,
    "category_id" TEXT,
    "brand_id" TEXT,
    "description" TEXT,
    "type" "ProductType" NOT NULL DEFAULT 'SIMPLE',
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "default_cost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "default_selling_price" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "minimum_stock" DECIMAL(18,4),
    "maximum_stock" DECIMAL(18,4),
    "base_uom_id" TEXT NOT NULL,
    "images" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "status" "ProductVariantStatus" NOT NULL DEFAULT 'ACTIVE',
    "cost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "selling_price" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "weight" DECIMAL(18,4),
    "dimensions" JSONB,
    "images" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_attribute_values" (
    "variant_id" TEXT NOT NULL,
    "attribute_id" TEXT NOT NULL,
    "attribute_value_id" TEXT NOT NULL,

    CONSTRAINT "variant_attribute_values_pkey" PRIMARY KEY ("variant_id","attribute_id")
);

-- CreateTable
CREATE TABLE "product_uoms" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "uom_id" TEXT NOT NULL,
    "conversion_factor" DECIMAL(18,6) NOT NULL,
    "is_purchase_uom" BOOLEAN NOT NULL DEFAULT false,
    "is_sales_uom" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_uoms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "barcodes" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "product_uom_id" TEXT,
    "code" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_lists" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_prices" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "price_list_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "price" DECIMAL(18,4) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_price_history" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "price_list_id" TEXT,
    "change_type" "PriceChangeType" NOT NULL,
    "old_value" DECIMAL(18,4),
    "new_value" DECIMAL(18,4) NOT NULL,
    "changed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_items" (
    "id" TEXT NOT NULL,
    "bundle_product_id" TEXT NOT NULL,
    "component_variant_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bundle_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "categories_business_id_idx" ON "categories"("business_id");

-- CreateIndex
CREATE INDEX "categories_parent_id_idx" ON "categories"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_business_id_parent_id_name_key" ON "categories"("business_id", "parent_id", "name");

-- CreateIndex
CREATE INDEX "brands_business_id_idx" ON "brands"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "brands_business_id_name_key" ON "brands"("business_id", "name");

-- CreateIndex
CREATE INDEX "uoms_business_id_idx" ON "uoms"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "uoms_business_id_name_key" ON "uoms"("business_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "uoms_business_id_code_key" ON "uoms"("business_id", "code");

-- CreateIndex
CREATE INDEX "product_attributes_business_id_idx" ON "product_attributes"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_attributes_business_id_name_key" ON "product_attributes"("business_id", "name");

-- CreateIndex
CREATE INDEX "product_attribute_values_business_id_idx" ON "product_attribute_values"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_attribute_values_attribute_id_value_key" ON "product_attribute_values"("attribute_id", "value");

-- CreateIndex
CREATE UNIQUE INDEX "product_attribute_values_id_attribute_id_key" ON "product_attribute_values"("id", "attribute_id");

-- CreateIndex
CREATE INDEX "products_business_id_idx" ON "products"("business_id");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "products_brand_id_idx" ON "products"("brand_id");

-- CreateIndex
CREATE INDEX "products_status_idx" ON "products"("status");

-- CreateIndex
CREATE UNIQUE INDEX "products_business_id_sku_key" ON "products"("business_id", "sku");

-- CreateIndex
CREATE INDEX "product_variants_business_id_idx" ON "product_variants"("business_id");

-- CreateIndex
CREATE INDEX "product_variants_product_id_idx" ON "product_variants"("product_id");

-- CreateIndex
CREATE INDEX "product_variants_status_idx" ON "product_variants"("status");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_business_id_sku_key" ON "product_variants"("business_id", "sku");

-- CreateIndex
CREATE INDEX "variant_attribute_values_attribute_value_id_idx" ON "variant_attribute_values"("attribute_value_id");

-- CreateIndex
CREATE INDEX "product_uoms_business_id_idx" ON "product_uoms"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_uoms_product_id_uom_id_key" ON "product_uoms"("product_id", "uom_id");

-- CreateIndex
CREATE INDEX "barcodes_variant_id_idx" ON "barcodes"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "barcodes_business_id_code_key" ON "barcodes"("business_id", "code");

-- CreateIndex
CREATE INDEX "price_lists_business_id_idx" ON "price_lists"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_business_id_name_key" ON "price_lists"("business_id", "name");

-- CreateIndex
CREATE INDEX "product_prices_business_id_idx" ON "product_prices"("business_id");

-- CreateIndex
CREATE INDEX "product_prices_variant_id_idx" ON "product_prices"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_prices_price_list_id_variant_id_key" ON "product_prices"("price_list_id", "variant_id");

-- CreateIndex
CREATE INDEX "product_price_history_business_id_idx" ON "product_price_history"("business_id");

-- CreateIndex
CREATE INDEX "product_price_history_variant_id_idx" ON "product_price_history"("variant_id");

-- CreateIndex
CREATE INDEX "bundle_items_component_variant_id_idx" ON "bundle_items"("component_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_items_bundle_product_id_component_variant_id_key" ON "bundle_items"("bundle_product_id", "component_variant_id");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uoms" ADD CONSTRAINT "uoms_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_attributes" ADD CONSTRAINT "attributes_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "attribute_values_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "product_attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_base_uom_id_fkey" FOREIGN KEY ("base_uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "variants_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_attribute_value_id_attribute_id_fkey" FOREIGN KEY ("attribute_value_id", "attribute_id") REFERENCES "product_attribute_values"("id", "attribute_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_uoms" ADD CONSTRAINT "product_uoms_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_uoms" ADD CONSTRAINT "product_uoms_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_uoms" ADD CONSTRAINT "product_uoms_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_product_uom_id_fkey" FOREIGN KEY ("product_uom_id") REFERENCES "product_uoms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price_history" ADD CONSTRAINT "price_history_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_items" ADD CONSTRAINT "bundle_items_bundle_product_id_fkey" FOREIGN KEY ("bundle_product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_items" ADD CONSTRAINT "bundle_items_component_variant_id_fkey" FOREIGN KEY ("component_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Extra integrity constraints Prisma's schema DSL cannot express directly.
-- ============================================================================

-- Top-level categories (parent_id IS NULL) must still have unique names per
-- business. The @@unique([businessId, parentId, name]) index above does NOT
-- catch this because Postgres treats every NULL as distinct from every other
-- NULL in a regular unique index.
CREATE UNIQUE INDEX "categories_top_level_name_unique"
  ON "categories" ("business_id", "name")
  WHERE "parent_id" IS NULL;

-- At most one primary barcode per variant.
CREATE UNIQUE INDEX "barcodes_one_primary_per_variant"
  ON "barcodes" ("variant_id")
  WHERE "is_primary" = true;

-- At most one default price list per business.
CREATE UNIQUE INDEX "price_lists_one_default_per_business"
  ON "price_lists" ("business_id")
  WHERE "is_default" = true;

-- Non-negative money/quantity guards (defense in depth alongside
-- application-layer zod validation - a direct DB write can never produce a
-- negative cost, price, stock threshold, conversion factor or bundle
-- quantity).
ALTER TABLE "products"
  ADD CONSTRAINT "products_default_cost_nonneg" CHECK ("default_cost" >= 0),
  ADD CONSTRAINT "products_default_price_nonneg" CHECK ("default_selling_price" >= 0),
  ADD CONSTRAINT "products_minimum_stock_nonneg" CHECK ("minimum_stock" IS NULL OR "minimum_stock" >= 0),
  ADD CONSTRAINT "products_maximum_stock_nonneg" CHECK ("maximum_stock" IS NULL OR "maximum_stock" >= 0),
  ADD CONSTRAINT "products_stock_range_valid" CHECK (
    "minimum_stock" IS NULL OR "maximum_stock" IS NULL OR "maximum_stock" >= "minimum_stock"
  );

ALTER TABLE "product_variants"
  ADD CONSTRAINT "variants_cost_nonneg" CHECK ("cost" >= 0),
  ADD CONSTRAINT "variants_selling_price_nonneg" CHECK ("selling_price" >= 0),
  ADD CONSTRAINT "variants_weight_nonneg" CHECK ("weight" IS NULL OR "weight" >= 0);

ALTER TABLE "product_uoms"
  ADD CONSTRAINT "product_uoms_factor_positive" CHECK ("conversion_factor" > 0);

ALTER TABLE "product_prices"
  ADD CONSTRAINT "product_prices_price_nonneg" CHECK ("price" >= 0);

ALTER TABLE "product_price_history"
  ADD CONSTRAINT "price_history_new_value_nonneg" CHECK ("new_value" >= 0);

ALTER TABLE "bundle_items"
  ADD CONSTRAINT "bundle_items_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "uoms"
  ADD CONSTRAINT "uoms_precision_nonneg" CHECK ("precision" >= 0 AND "precision" <= 6);
