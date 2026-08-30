-- CreateTable
CREATE TABLE "sale_return_item_serials" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "sale_return_id" TEXT NOT NULL,
    "sale_return_item_id" TEXT NOT NULL,
    "serial_number_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_return_item_serials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_return_item_serials_business_id_idx" ON "sale_return_item_serials"("business_id");

-- CreateIndex
CREATE INDEX "sale_return_item_serials_sale_return_id_idx" ON "sale_return_item_serials"("sale_return_id");

-- CreateIndex
CREATE INDEX "sale_return_item_serials_serial_number_id_idx" ON "sale_return_item_serials"("serial_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_return_item_serials_business_id_sale_return_item_id_se_key" ON "sale_return_item_serials"("business_id", "sale_return_item_id", "serial_number_id");

-- AddForeignKey
ALTER TABLE "sale_return_item_serials" ADD CONSTRAINT "sale_return_item_serials_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_item_serials" ADD CONSTRAINT "sale_return_item_serials_sale_return_id_fkey" FOREIGN KEY ("sale_return_id") REFERENCES "sale_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_item_serials" ADD CONSTRAINT "sale_return_item_serials_sale_return_item_id_fkey" FOREIGN KEY ("sale_return_item_id") REFERENCES "sale_return_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_item_serials" ADD CONSTRAINT "sale_return_item_serials_serial_number_id_fkey" FOREIGN KEY ("serial_number_id") REFERENCES "serial_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
