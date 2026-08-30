-- sale_item_serials: SELECT + INSERT ONLY. No UPDATE, no DELETE.
--
-- "This physical unit left on this sale line" is a permanent historical
-- fact. It stays true even after the unit is returned - the return is
-- recorded by the SerialNumber's own status transition and by the
-- SaleReturn document, never by erasing or rewriting the sale record.
-- Making the grant append-only is what turns that from a convention into
-- a database guarantee, matching customer_points, journal_entries and
-- sale_promotion_applications.
--
-- Nothing locks this table: the concurrency boundary for "who gets this
-- serial" is the serial_numbers row itself, which already carries the
-- UPDATE privilege it needs for SELECT ... FOR UPDATE (granted in the
-- Phase 3 inventory migration), so no new grant is required for the
-- Phase 8E lock ordering either.

GRANT SELECT, INSERT ON "sale_item_serials" TO erp_app;
