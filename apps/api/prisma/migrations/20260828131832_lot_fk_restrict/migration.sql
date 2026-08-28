-- DropForeignKey
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_lot_id_fkey";

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "inventory_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
