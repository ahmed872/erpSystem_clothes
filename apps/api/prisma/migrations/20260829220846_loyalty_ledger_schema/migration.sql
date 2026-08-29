-- CreateEnum
CREATE TYPE "CustomerPointsType" AS ENUM ('EARN', 'REDEEM', 'RETURN_CLAWBACK', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "customer_points" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "type" "CustomerPointsType" NOT NULL,
    "points" DECIMAL(18,4) NOT NULL,
    "basis_amount" DECIMAL(18,4),
    "rate_snapshot" DECIMAL(18,6),
    "reference_type" TEXT,
    "reference_id" TEXT,
    "description" TEXT,
    "idempotency_key" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_points_business_id_idx" ON "customer_points"("business_id");

-- CreateIndex
CREATE INDEX "customer_points_business_id_customer_id_idx" ON "customer_points"("business_id", "customer_id");

-- CreateIndex
CREATE INDEX "customer_points_reference_type_reference_id_idx" ON "customer_points"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "customer_points_type_idx" ON "customer_points"("type");

-- CreateIndex
CREATE UNIQUE INDEX "customer_points_business_id_idempotency_key_key" ON "customer_points"("business_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "customer_points" ADD CONSTRAINT "customer_points_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_points" ADD CONSTRAINT "customer_points_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written integrity constraints (Phase 8B, approved loyalty policy)
-- ---------------------------------------------------------------------------

-- A zero-point event carries no information and would only pollute a
-- ledger whose entire purpose is SUM(points). Approved policy states
-- points <> 0 explicitly.
ALTER TABLE "customer_points"
  ADD CONSTRAINT "customer_points_nonzero" CHECK ("points" <> 0);

-- Sign discipline per event type. This is NOT a new business rule - it is
-- the database enforcing the meaning the approved policy already gives
-- each type: EARN adds, REDEEM spends, RETURN_CLAWBACK reverses part of a
-- prior EARN. Without it a REDEEM row with a positive value would silently
-- INCREASE a balance while reading as a spend, and no application check
-- alone could rule that out for a row inserted by a future code path.
-- ADJUSTMENT is deliberately unconstrained in sign: a human correction may
-- legitimately go either way (still never zero, per the constraint above).
ALTER TABLE "customer_points"
  ADD CONSTRAINT "customer_points_sign_matches_type" CHECK (
    ("type" = 'EARN' AND "points" > 0)
    OR ("type" = 'REDEEM' AND "points" < 0)
    OR ("type" = 'RETURN_CLAWBACK' AND "points" < 0)
    OR ("type" = 'ADJUSTMENT')
  );

-- The BD-3 earning snapshot must be all-or-nothing. A row carrying a
-- basis but no rate (or the reverse) could not reproduce its own
-- arithmetic, which is the entire point of snapshotting it.
ALTER TABLE "customer_points"
  ADD CONSTRAINT "customer_points_snapshot_complete" CHECK (
    ("basis_amount" IS NULL AND "rate_snapshot" IS NULL)
    OR ("basis_amount" IS NOT NULL AND "rate_snapshot" IS NOT NULL)
  );

-- A snapshotted rate is a points-per-currency-unit multiplier; a negative
-- one is meaningless and a zero one could only ever produce zero points,
-- which customer_points_nonzero already forbids.
ALTER TABLE "customer_points"
  ADD CONSTRAINT "customer_points_rate_positive" CHECK (
    "rate_snapshot" IS NULL OR "rate_snapshot" > 0
  );
