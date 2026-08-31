-- Phase 10 (10F): the business identity a printed receipt needs.
--
-- All nullable and all free text. The product ships knowing nothing about
-- any country's invoicing rules, so it stores what the business tells it
-- rather than validating against a regime it has not been told about;
-- jurisdiction-aware e-invoicing is a separate, deferred decision.

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "address_line" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "legal_name" TEXT,
ADD COLUMN     "logo_url" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "receipt_footer" TEXT,
ADD COLUMN     "receipt_header" TEXT,
ADD COLUMN     "registration_number" TEXT,
ADD COLUMN     "tax_number" TEXT;

