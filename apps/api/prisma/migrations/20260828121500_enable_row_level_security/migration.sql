-- Multi-tenant isolation via PostgreSQL Row-Level Security.
--
-- Design (see docs/architecture/PHASE-0-ARCHITECTURE.md §5):
-- every tenant-scoped table is protected by a policy comparing its
-- business_id (directly, or transitively via a parent FK for pure join
-- tables) to current_setting('app.current_tenant_id', true), which
-- the API sets via `SET LOCAL` at the start of every request transaction
-- (see PrismaTenantService). When the GUC is unset, current_setting(...,
-- true) returns NULL, so `business_id = NULL` is UNKNOWN -> every row is
-- filtered out and every write is rejected. This means the *default is
-- deny*, not allow: a bug that forgets to set tenant context fails safe
-- (empty result / rejected write) instead of leaking cross-tenant data.
--
-- `businesses` itself is the one deliberate exception: SELECT is public
-- (USING (true)) because business login needs to resolve a tenant by its
-- public `slug` *before* any tenant context exists. The columns exposed
-- by that row (name, slug, currency, timezone, status) are not sensitive
-- - equivalent to a company having a public "sign in to Acme Clothing"
-- page. INSERT/UPDATE on businesses still require the row's own id to
-- match the tenant context, so a business can only ever write itself:
-- business creation generates the id application-side and calls
-- `SET LOCAL app.current_tenant_id` to that id inside the same
-- transaction before inserting anything, so no special-case bypass is
-- needed anywhere in this file.

ALTER TABLE "businesses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "businesses" FORCE ROW LEVEL SECURITY;

CREATE POLICY businesses_select_public ON "businesses"
  FOR SELECT
  USING (true);

CREATE POLICY businesses_insert_own ON "businesses"
  FOR INSERT
  WITH CHECK (id = current_setting('app.current_tenant_id', true));

CREATE POLICY businesses_update_own ON "businesses"
  FOR UPDATE
  USING (id = current_setting('app.current_tenant_id', true))
  WITH CHECK (id = current_setting('app.current_tenant_id', true));

-- No DELETE policy -> DELETE is denied outright (tenants are suspended
-- via status, never hard-deleted).

-- Straightforward business_id-scoped tables --------------------------------

ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY branches_tenant_isolation ON "branches"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));

ALTER TABLE "warehouses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "warehouses" FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouses_tenant_isolation ON "warehouses"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolation ON "users"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));

ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_tenant_isolation ON "roles"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));

ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY settings_tenant_isolation ON "settings"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_tenant_isolation ON "audit_logs"
  USING (business_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (business_id = current_setting('app.current_tenant_id', true));

-- Permission catalog is global (not tenant-scoped) -> no RLS. It is
-- read-only for the application role in any case (see next migration).

-- Pure join / child tables without their own business_id: scoped via the
-- parent row's tenant. These are the "defense in depth" layer for
-- direct queries against the join tables themselves.

ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_roles_tenant_isolation ON "user_roles"
  USING (
    EXISTS (
      SELECT 1 FROM "users" u
      WHERE u.id = "user_roles".user_id
        AND u.business_id = current_setting('app.current_tenant_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "users" u
      WHERE u.id = "user_roles".user_id
        AND u.business_id = current_setting('app.current_tenant_id', true)
    )
    AND EXISTS (
      SELECT 1 FROM "roles" r
      WHERE r.id = "user_roles".role_id
        AND r.business_id = current_setting('app.current_tenant_id', true)
    )
  );

ALTER TABLE "user_branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_branches_tenant_isolation ON "user_branches"
  USING (
    EXISTS (
      SELECT 1 FROM "users" u
      WHERE u.id = "user_branches".user_id
        AND u.business_id = current_setting('app.current_tenant_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "users" u
      WHERE u.id = "user_branches".user_id
        AND u.business_id = current_setting('app.current_tenant_id', true)
    )
    AND EXISTS (
      SELECT 1 FROM "branches" b
      WHERE b.id = "user_branches".branch_id
        AND b.business_id = current_setting('app.current_tenant_id', true)
    )
  );

ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_tenant_isolation ON "role_permissions"
  USING (
    EXISTS (
      SELECT 1 FROM "roles" r
      WHERE r.id = "role_permissions".role_id
        AND r.business_id = current_setting('app.current_tenant_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "roles" r
      WHERE r.id = "role_permissions".role_id
        AND r.business_id = current_setting('app.current_tenant_id', true)
    )
  );

-- refresh_tokens: the refresh token itself is a signed JWT carrying the
-- tenant id as a claim (see AuthTokenService), so the API can set tenant
-- context *before* looking the row up by id/hash - no chicken-and-egg
-- problem, and the same uniform policy applies.
ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_tokens_tenant_isolation ON "refresh_tokens"
  USING (
    EXISTS (
      SELECT 1 FROM "users" u
      WHERE u.id = "refresh_tokens".user_id
        AND u.business_id = current_setting('app.current_tenant_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "users" u
      WHERE u.id = "refresh_tokens".user_id
        AND u.business_id = current_setting('app.current_tenant_id', true)
    )
  );
