-- PostgreSQL requires the UPDATE privilege (not just SELECT) to execute
-- `SELECT ... FOR UPDATE` against a table, even though no application
-- code path ever issues a real content-changing UPDATE against `sales` -
-- row-level locking is treated as write-intent by Postgres regardless of
-- whether the lock is ever followed by an actual write. Discovered by a
-- real e2e test failure (a genuine "permission denied" error from
-- Postgres itself), not by re-reading the grants migration - the
-- original `sales_app_role_grants` migration deliberately withheld
-- UPDATE reasoning "nothing ever content-updates a Sale row", which
-- turned out to be too narrow: `lockSale` (domain/lock-sale.ts) takes
-- `SELECT ... FOR UPDATE` on it for CreateSalePaymentUseCase and
-- CreateSaleReturnUseCase, and that clause alone requires the grant.
--
-- This does NOT weaken the "sales is an immutable event record" design
-- intent - erp_app still cannot meaningfully exploit UPDATE, since every
-- application code path only ever SELECTs ... FOR UPDATE and then reads
-- (never writes) the sales row itself; the grant is a Postgres locking
-- mechanic, not an invitation to mutate sale history.

GRANT UPDATE ON "sales" TO erp_app;
