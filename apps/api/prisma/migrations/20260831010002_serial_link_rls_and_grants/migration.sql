-- Phase 10 (10D): RLS + grants for the three serial link tables.
--
-- Same default-deny pattern and the same append-only posture as
-- sale_item_serials and sale_return_item_serials: "this physical unit
-- moved on this document" is a permanent historical fact, so SELECT +
-- INSERT only, never UPDATE or DELETE. A correction is a new document,
-- not an edit to an old one.
--
-- Nothing locks these tables. The concurrency boundary for a serial is
-- the serial_numbers row itself, taken with SELECT ... FOR UPDATE in
-- deterministic id order by every path that moves one.

ALTER TABLE "purchase_receipt_item_serials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_receipt_item_serials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "purchase_receipt_item_serials_tenant_isolation" ON "purchase_receipt_item_serials"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));
GRANT SELECT, INSERT ON "purchase_receipt_item_serials" TO erp_app;

ALTER TABLE "stock_transfer_item_serials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_transfer_item_serials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "stock_transfer_item_serials_tenant_isolation" ON "stock_transfer_item_serials"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));
GRANT SELECT, INSERT ON "stock_transfer_item_serials" TO erp_app;

ALTER TABLE "purchase_return_item_serials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_return_item_serials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "purchase_return_item_serials_tenant_isolation" ON "purchase_return_item_serials"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));
GRANT SELECT, INSERT ON "purchase_return_item_serials" TO erp_app;
