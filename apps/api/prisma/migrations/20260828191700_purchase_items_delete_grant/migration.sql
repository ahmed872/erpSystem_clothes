-- A DRAFT Purchase's line items are edited in place by
-- UpdatePurchaseUseCase (removed lines are deleted, not just orphaned),
-- which needs a DELETE grant on purchase_items that the prior
-- app-role-grants migration deliberately withheld. This is safe and does
-- NOT weaken the "no hard delete of historical records" principle:
-- purchase_receipt_items.purchase_item_id and
-- purchase_return_items.purchase_item_id both carry
-- ON DELETE RESTRICT foreign keys, so Postgres itself refuses to delete
-- any PurchaseItem that has ever been received or returned against,
-- regardless of what the application layer does or fails to check. Only
-- a PurchaseItem that has never been touched by receiving/returning -
-- i.e. one that only ever existed within an application-enforced DRAFT
-- purchase - can actually be deleted.

GRANT DELETE ON "purchase_items" TO erp_app;
