-- Runtime application role.
--
-- CRITICAL: the NestJS API must connect using this role (RUNTIME_DATABASE_URL),
-- never the migration/superuser role (DATABASE_URL). Superusers implicitly
-- BYPASSRLS, which would silently disable every policy in the previous
-- migration. erp_app is created NOSUPERUSER / NOBYPASSRLS on purpose.
--
-- The password below is a development default. Production deployments
-- MUST rotate it out-of-band (`ALTER ROLE erp_app WITH PASSWORD '...'`
-- via the deployment/secrets pipeline) immediately after first deploy -
-- it is intentionally not templated from an env var here because plain
-- migration SQL has no variable substitution, and baking a real secret
-- into version control would be worse.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'erp_app') THEN
    CREATE ROLE erp_app LOGIN PASSWORD 'erp_app_dev_only_change_in_prod' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END
$$;

DO $$
DECLARE dbname text := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO erp_app', dbname);
END
$$;

GRANT USAGE ON SCHEMA public TO erp_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

-- Tenant root: no DELETE. Suspension is via status = SUSPENDED, never a
-- hard delete of a business.
GRANT SELECT, INSERT, UPDATE ON "businesses" TO erp_app;

-- Master/config data: full CRUD. These are not financial documents, so
-- hard delete is acceptable here (unlike invoices/journal entries in
-- later phases) - the application layer nonetheless prefers the
-- is_active flag for branches/warehouses once other modules start
-- referencing them.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "branches", "warehouses", "users", "roles", "settings",
  "user_roles", "user_branches", "role_permissions", "refresh_tokens"
  TO erp_app;

-- Global permission catalog: read-only for the app. It is seeded by the
-- migration/deploy role only (prisma/seed.ts run with DATABASE_URL, not
-- RUNTIME_DATABASE_URL).
GRANT SELECT ON "permissions" TO erp_app;

-- Audit log: append-only at the database privilege level, independent of
-- (and in addition to) application code discipline. No UPDATE, no
-- DELETE - ever.
GRANT SELECT, INSERT ON "audit_logs" TO erp_app;
