-- CreateTable
CREATE TABLE "purchase_receipt_item_serials" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_receipt_id" TEXT NOT NULL,
    "purchase_receipt_item_id" TEXT NOT NULL,
    "serial_number_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_receipt_item_serials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_item_serials" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "stock_transfer_id" TEXT NOT NULL,
    "stock_transfer_item_id" TEXT NOT NULL,
    "serial_number_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transfer_item_serials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_return_item_serials" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_return_id" TEXT NOT NULL,
    "purchase_return_item_id" TEXT NOT NULL,
    "serial_number_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_return_item_serials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_receipt_item_serials_business_id_idx" ON "purchase_receipt_item_serials"("business_id");

-- CreateIndex
CREATE INDEX "purchase_receipt_item_serials_purchase_receipt_id_idx" ON "purchase_receipt_item_serials"("purchase_receipt_id");

-- CreateIndex
CREATE INDEX "purchase_receipt_item_serials_serial_number_id_idx" ON "purchase_receipt_item_serials"("serial_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipt_item_serials_business_id_purchase_receipt__key" ON "purchase_receipt_item_serials"("business_id", "purchase_receipt_item_id", "serial_number_id");

-- CreateIndex
CREATE INDEX "stock_transfer_item_serials_business_id_idx" ON "stock_transfer_item_serials"("business_id");

-- CreateIndex
CREATE INDEX "stock_transfer_item_serials_stock_transfer_id_idx" ON "stock_transfer_item_serials"("stock_transfer_id");

-- CreateIndex
CREATE INDEX "stock_transfer_item_serials_serial_number_id_idx" ON "stock_transfer_item_serials"("serial_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_item_serials_business_id_stock_transfer_item_key" ON "stock_transfer_item_serials"("business_id", "stock_transfer_item_id", "serial_number_id");

-- CreateIndex
CREATE INDEX "purchase_return_item_serials_business_id_idx" ON "purchase_return_item_serials"("business_id");

-- CreateIndex
CREATE INDEX "purchase_return_item_serials_purchase_return_id_idx" ON "purchase_return_item_serials"("purchase_return_id");

-- CreateIndex
CREATE INDEX "purchase_return_item_serials_serial_number_id_idx" ON "purchase_return_item_serials"("serial_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_return_item_serials_business_id_purchase_return_it_key" ON "purchase_return_item_serials"("business_id", "purchase_return_item_id", "serial_number_id");

-- AddForeignKey
ALTER TABLE "purchase_receipt_item_serials" ADD CONSTRAINT "purchase_receipt_item_serials_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_item_serials" ADD CONSTRAINT "purchase_receipt_item_serials_purchase_receipt_id_fkey" FOREIGN KEY ("purchase_receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_item_serials" ADD CONSTRAINT "purchase_receipt_item_serials_purchase_receipt_item_id_fkey" FOREIGN KEY ("purchase_receipt_item_id") REFERENCES "purchase_receipt_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_item_serials" ADD CONSTRAINT "purchase_receipt_item_serials_serial_number_id_fkey" FOREIGN KEY ("serial_number_id") REFERENCES "serial_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_item_serials" ADD CONSTRAINT "stock_transfer_item_serials_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_item_serials" ADD CONSTRAINT "stock_transfer_item_serials_stock_transfer_id_fkey" FOREIGN KEY ("stock_transfer_id") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_item_serials" ADD CONSTRAINT "stock_transfer_item_serials_stock_transfer_item_id_fkey" FOREIGN KEY ("stock_transfer_item_id") REFERENCES "stock_transfer_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_item_serials" ADD CONSTRAINT "stock_transfer_item_serials_serial_number_id_fkey" FOREIGN KEY ("serial_number_id") REFERENCES "serial_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_item_serials" ADD CONSTRAINT "purchase_return_item_serials_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_item_serials" ADD CONSTRAINT "purchase_return_item_serials_purchase_return_id_fkey" FOREIGN KEY ("purchase_return_id") REFERENCES "purchase_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_item_serials" ADD CONSTRAINT "purchase_return_item_serials_purchase_return_item_id_fkey" FOREIGN KEY ("purchase_return_item_id") REFERENCES "purchase_return_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_item_serials" ADD CONSTRAINT "purchase_return_item_serials_serial_number_id_fkey" FOREIGN KEY ("serial_number_id") REFERENCES "serial_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

