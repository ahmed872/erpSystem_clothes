-- CreateTable
CREATE TABLE "sale_item_serials" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "sale_item_id" TEXT NOT NULL,
    "serial_number_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_item_serials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_item_serials_business_id_idx" ON "sale_item_serials"("business_id");

-- CreateIndex
CREATE INDEX "sale_item_serials_sale_id_idx" ON "sale_item_serials"("sale_id");

-- CreateIndex
CREATE INDEX "sale_item_serials_sale_item_id_idx" ON "sale_item_serials"("sale_item_id");

-- CreateIndex
CREATE INDEX "sale_item_serials_serial_number_id_idx" ON "sale_item_serials"("serial_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_item_serials_business_id_sale_item_id_serial_number_id_key" ON "sale_item_serials"("business_id", "sale_item_id", "serial_number_id");

-- AddForeignKey
ALTER TABLE "sale_item_serials" ADD CONSTRAINT "sale_item_serials_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item_serials" ADD CONSTRAINT "sale_item_serials_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item_serials" ADD CONSTRAINT "sale_item_serials_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "sale_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item_serials" ADD CONSTRAINT "sale_item_serials_serial_number_id_fkey" FOREIGN KEY ("serial_number_id") REFERENCES "serial_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
