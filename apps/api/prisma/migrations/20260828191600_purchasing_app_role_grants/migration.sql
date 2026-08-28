-- Extends erp_app with exactly the privileges each Phase 4 table needs.
--
-- suppliers / purchases / purchase_items get UPDATE because their
-- lifecycle genuinely mutates in place: a Supplier's contact details can
-- change; a Purchase's status/approval fields transition
-- DRAFT -> APPROVED -> PARTIALLY_RECEIVED -> RECEIVED (or -> CANCELLED);
-- purchase_items.quantity_received / quantity_returned are the
-- document-level running totals that each receiving/return operation
-- increments under a row lock (see PurchaseItem model comment). None of
-- them ever get DELETE - nothing in Purchasing is a record that should
-- vanish, same precedent as every other domain in this system.
--
-- Everything else here is an EVENT record, not a document with a mutable
-- lifecycle - a receipt, a return, a payment, a supplier ledger entry are
-- all facts about something that already happened and must stay
-- append-only forever, exactly like stock_movements in Phase 3:
-- supplier_transactions is the ledger books balances are derived from,
-- and purchase_receipts/purchase_receipt_items/purchase_returns/
-- purchase_return_items/purchase_payments are the historical record of
-- what was received, returned, or paid. A correction to any of these is
-- always a NEW row (e.g. a purchase return reversing a receipt, or a new
-- SupplierTransaction adjustment), never an edit of history.

GRANT SELECT, INSERT, UPDATE ON
  "suppliers", "purchases", "purchase_items"
  TO erp_app;

GRANT SELECT, INSERT ON
  "supplier_transactions",
  "purchase_receipts", "purchase_receipt_items",
  "purchase_returns", "purchase_return_items",
  "purchase_payments"
  TO erp_app;
