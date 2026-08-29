-- Extends erp_app with exactly the privileges each Phase 5 table needs.
--
-- customers / shifts / sale_items get UPDATE because their lifecycle
-- genuinely mutates in place: a Customer's contact details can change;
-- a Shift transitions OPEN -> CLOSED (closed_by/closed_at); sale_items
-- .quantity_returned is the document-level running total that each
-- return operation increments under the Sale-row lock (see
-- domain/lock-sale.ts). None of them ever get DELETE - nothing in Sales
-- is a record that should vanish, same precedent as every other domain.
--
-- Notably, unlike Purchasing, NOTHING in Sales needs a DELETE grant at
-- all: Purchasing's purchase_items needed one narrowly to support
-- editing a still-DRAFT purchase's line items, but Sales has no
-- DRAFT-edit lifecycle whatsoever (a Sale is created already-COMPLETE in
-- one atomic call, per the Phase 5 scope decision to leave Held
-- Invoices out) - so sale_items never needs its rows removed, only its
-- running totals updated.
--
-- `sales` itself gets SELECT+INSERT ONLY - stricter than `purchases`
-- (which needs UPDATE for its multi-step DRAFT/APPROVED/.../CANCELLED
-- lifecycle). A Sale row, once inserted, is a completed, immutable event
-- record for the entirety of Phase 5 v1 - there is no application code
-- path that would ever call sale.update(). Everything else here is
-- likewise an EVENT record - a customer ledger entry, a payment, a
-- return - append-only forever, exactly like stock_movements/
-- supplier_transactions: a correction is always a NEW row, never an edit
-- of history.

GRANT SELECT, INSERT, UPDATE ON
  "customers", "shifts", "sale_items"
  TO erp_app;

GRANT SELECT, INSERT ON
  "customer_transactions",
  "sales", "sale_payments",
  "sale_returns", "sale_return_items"
  TO erp_app;
