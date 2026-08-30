-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'BUY_X_GET_Y');

-- CreateEnum
CREATE TYPE "PromotionTargetType" AS ENUM ('PRODUCT', 'VARIANT', 'CATEGORY');

-- CreateTable
CREATE TABLE "promotions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PromotionType" NOT NULL,
    "target_type" "PromotionTargetType" NOT NULL,
    "target_id" TEXT NOT NULL,
    "percentage_value" DECIMAL(9,4),
    "fixed_amount" DECIMAL(18,4),
    "buy_quantity" INTEGER,
    "get_quantity" INTEGER,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_promotion_applications" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "sale_item_id" TEXT NOT NULL,
    "promotion_id" TEXT NOT NULL,
    "promotion_type" "PromotionType" NOT NULL,
    "promotion_name" TEXT NOT NULL,
    "rule_snapshot" JSONB NOT NULL,
    "discount_applied" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_promotion_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promotions_business_id_idx" ON "promotions"("business_id");

-- CreateIndex
CREATE INDEX "promotions_business_id_target_type_target_id_idx" ON "promotions"("business_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "promotions_business_id_valid_from_valid_to_idx" ON "promotions"("business_id", "valid_from", "valid_to");

-- CreateIndex
CREATE INDEX "sale_promotion_applications_business_id_idx" ON "sale_promotion_applications"("business_id");

-- CreateIndex
CREATE INDEX "sale_promotion_applications_sale_id_idx" ON "sale_promotion_applications"("sale_id");

-- CreateIndex
CREATE INDEX "sale_promotion_applications_sale_item_id_idx" ON "sale_promotion_applications"("sale_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_promotion_applications_business_id_sale_item_id_promot_key" ON "sale_promotion_applications"("business_id", "sale_item_id", "promotion_id");

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_promotion_applications" ADD CONSTRAINT "sale_promotion_applications_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_promotion_applications" ADD CONSTRAINT "sale_promotion_applications_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_promotion_applications" ADD CONSTRAINT "sale_promotion_applications_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "sale_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_promotion_applications" ADD CONSTRAINT "sale_promotion_applications_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written integrity constraints (Phase 8D, approved promotion policy)
-- ---------------------------------------------------------------------------

-- Exactly one parameter set per type, and nothing else populated. Without
-- this a row could carry a percentage AND a buy/get pair, and which one
-- the engine honoured would depend on code order rather than on data.
ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_parameters_match_type" CHECK (
    (
      "type" = 'PERCENTAGE'
      AND "percentage_value" IS NOT NULL
      AND "fixed_amount" IS NULL AND "buy_quantity" IS NULL AND "get_quantity" IS NULL
    )
    OR (
      "type" = 'FIXED_AMOUNT'
      AND "fixed_amount" IS NOT NULL
      AND "percentage_value" IS NULL AND "buy_quantity" IS NULL AND "get_quantity" IS NULL
    )
    OR (
      "type" = 'BUY_X_GET_Y'
      AND "buy_quantity" IS NOT NULL AND "get_quantity" IS NOT NULL
      AND "percentage_value" IS NULL AND "fixed_amount" IS NULL
    )
  );

-- A percentage above 100 would drive a line negative; at or below zero it
-- is not a discount at all.
ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_percentage_range" CHECK (
    "percentage_value" IS NULL OR ("percentage_value" > 0 AND "percentage_value" <= 100)
  );

ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_fixed_amount_positive" CHECK (
    "fixed_amount" IS NULL OR "fixed_amount" > 0
  );

-- X and Y are whole units of stock. A zero X would make every unit free
-- and a zero Y would make the promotion a no-op.
ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_bxgy_quantities_positive" CHECK (
    ("buy_quantity" IS NULL OR "buy_quantity" > 0)
    AND ("get_quantity" IS NULL OR "get_quantity" > 0)
  );

-- Half-open [valid_from, valid_to): an empty or inverted window would
-- either never match or match ambiguously.
ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_valid_window" CHECK ("valid_to" > "valid_from");

ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_name_not_empty" CHECK (length(btrim("name")) > 0);

-- A promotion that reduced a line by nothing is not recorded at all (the
-- application writes no row), so a stored application always represents
-- real money.
ALTER TABLE "sale_promotion_applications"
  ADD CONSTRAINT "sale_promotion_applications_discount_positive" CHECK ("discount_applied" > 0);
