#!/usr/bin/env bash
# ---------------------------------------------------------------------
# Retail Operating System — restore
#
# Phase 11. Restores a pg_dump custom-format archive into a TARGET
# database that must already exist and must be empty.
#
# REFUSES to restore over a database that already has tables. A restore is
# not a merge: pg_restore into a populated database produces a mixture of
# old and new rows with duplicate-key errors scattered through it, which is
# far worse than a clean failure. Drop and recreate the target first, as a
# deliberate act.
#
# Usage:
#   TARGET_URL=postgresql://postgres:...@host:5432/erp_restored \
#   ops/restore.sh path/to/backup.dump
# ---------------------------------------------------------------------
set -euo pipefail

: "${TARGET_URL:?TARGET_URL must be set (owner connection to the TARGET database)}"
ARCHIVE="${1:?usage: restore.sh <archive.dump>}"

# Every connection string in this project carries Prisma's `?schema=public`
# query parameter. libpq rejects it outright ("invalid URI query
# parameter"), so it is stripped here rather than asking every operator to
# hand-edit a URL under incident pressure.
strip_prisma_params() {
  printf '%s' "$1" | sed -E 's/[?&]schema=[^&]*//g; s/\?$//'
}

PG_URL="$(strip_prisma_params "$TARGET_URL")"

[ -f "$ARCHIVE" ] || { echo "!!! no such archive: $ARCHIVE" >&2; exit 1; }

echo "==> checking the target is empty"
EXISTING="$(psql "$PG_URL" -tAc \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")"
if [ "$EXISTING" -ne 0 ]; then
  echo "!!! target already has ${EXISTING} tables. A restore is not a merge." >&2
  echo "    Drop and recreate the target database, then run this again." >&2
  exit 1
fi

# The application role is cluster-wide. Restoring the grants without it
# produces a database the API cannot connect to - a restore that looks
# successful and leaves the service down.
echo "==> checking the erp_app role exists on the target cluster"
if [ "$(psql "$PG_URL" -tAc "SELECT count(*) FROM pg_roles WHERE rolname='erp_app'")" -eq 0 ]; then
  echo "!!! role 'erp_app' does not exist on this cluster." >&2
  echo "    Roles are cluster-wide and are NOT in the dump. Create it first:" >&2
  echo "    CREATE ROLE erp_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;" >&2
  exit 1
fi

echo "==> restoring ${ARCHIVE}"
pg_restore --dbname="$PG_URL" --no-owner --exit-on-error "$ARCHIVE"

# The three properties that matter more than row counts. A restore that
# brought back the data but lost RLS would be a silent, total tenant-
# isolation failure, so it is checked here rather than assumed.
echo "==> verifying security properties survived"
psql "$PG_URL" -tAc "
  SELECT 'tables without RLS+FORCE: ' || count(*) FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r'
     AND c.relname NOT IN ('_prisma_migrations','permissions')
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
  SELECT 'append-only tables holding UPDATE/DELETE: ' || count(*)
    FROM information_schema.role_table_grants
   WHERE grantee='erp_app' AND privilege_type IN ('UPDATE','DELETE')
     AND table_name IN ('stock_movements','journal_entries','journal_entry_lines','customer_points',
                        'cash_transactions','expenses','audit_logs','sale_returns');
  SELECT 'businesses restored: ' || count(*) FROM businesses;
  SELECT 'sales restored: ' || count(*) FROM sales;
"

echo "==> restore complete"
