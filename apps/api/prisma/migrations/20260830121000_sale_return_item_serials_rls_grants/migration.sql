-- RLS + grants for the Phase 8E return-direction serial link, same
-- default-deny pattern and same append-only posture as
-- sale_item_serials: "this unit came back on this document" is a
-- permanent historical fact, so SELECT + INSERT only, never UPDATE or
-- DELETE. Nothing locks this table - the concurrency boundary for a
-- serial is the serial_numbers row itself.

ALTER TABLE "sale_return_item_serials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_return_item_serials" FORCE ROW LEVEL SECURITY;

CREATE POLICY "sale_return_item_serials_tenant_isolation" ON "sale_return_item_serials"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT ON "sale_return_item_serials" TO erp_app;
