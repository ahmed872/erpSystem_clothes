-- Fix found during the Phase 4 review gate: purchase_receipt_items and
-- purchase_return_items were the only two tables in the entire schema
-- whose businessId relation was written without an explicit onDelete,
-- silently defaulting to RESTRICT instead of the CASCADE convention
-- every other business_id FK follows. Verified live (not just in the
-- schema file) by attempting to delete a business referencing rows in
-- these tables as the migration/owner role and observing a REAL
-- "violates foreign key constraint" error. Not reachable by the running
-- application (erp_app has no DELETE grant on businesses at all - same
-- "no hard delete" posture as every prior phase), so this was a latent
-- migration-hygiene inconsistency, not a security or tenant-isolation
-- issue. Also renames the FK to the "..._business_fk" convention used by
-- every other table (it had been left as Prisma's implicit default name).

-- DropForeignKey
ALTER TABLE "purchase_receipt_items" DROP CONSTRAINT "purchase_receipt_items_business_id_fkey";

-- DropForeignKey
ALTER TABLE "purchase_return_items" DROP CONSTRAINT "purchase_return_items_business_id_fkey";

-- AddForeignKey
ALTER TABLE "purchase_receipt_items" ADD CONSTRAINT "purchase_receipt_items_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_business_fk" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
