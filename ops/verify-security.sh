#!/usr/bin/env bash
# ---------------------------------------------------------------------
# Retail Operating System — structural security verification
#
# Phase 11. Asks POSTGRESQL what it will actually enforce, rather than
# asking the application what it believes. Every check below reads the
# system catalogues directly, so it holds even if the ORM, the use-cases
# and the whole test suite were wrong at the same time.
#
# It is the check to run after a restore, after a migration, and before a
# release. It writes nothing and needs only a connection that can read the
# catalogues.
#
# Usage:  ops/verify-security.sh [DATABASE_URL]
#         DATABASE_URL defaults to $DATABASE_URL.
# Exits non-zero, listing every failure, if anything has drifted.
# ---------------------------------------------------------------------
set -uo pipefail

# Prisma appends `?schema=public`, which libpq rejects as an unknown URI
# parameter. Strip it rather than making every caller remember to.
strip_prisma_params() { printf '%s' "${1%%\?*}"; }

RAW_URL="${1:-${DATABASE_URL:-}}"
if [[ -z "$RAW_URL" ]]; then
  echo "usage: ops/verify-security.sh [DATABASE_URL]   (or set DATABASE_URL)" >&2
  exit 2
fi
URL="$(strip_prisma_params "$RAW_URL")"

APP_ROLE="${APP_ROLE:-erp_app}"
FAILURES=0

# Runs a query that must return NO rows. Anything it returns is a finding.
expect_empty() {
  local title="$1" sql="$2" rows
  rows="$(psql "$URL" -At -F' | ' -c "$sql")" || { echo "  ERROR running: $title" >&2; FAILURES=$((FAILURES+1)); return; }
  if [[ -n "$rows" ]]; then
    echo "  FAIL  $title"
    while IFS= read -r line; do echo "          $line"; done <<< "$rows"
    FAILURES=$((FAILURES+1))
  else
    echo "  ok    $title"
  fi
}

count_of() { psql "$URL" -At -c "$1"; }

echo "Structural security verification — $(psql "$URL" -At -c 'SELECT current_database()')"
echo

# ---------------------------------------------------------------------
echo "Row-level security"
# ---------------------------------------------------------------------
# FORCE matters as much as ENABLE: without it the table owner - which is
# who migrations run as - silently bypasses every policy.
expect_empty "every table carrying business_id has RLS *and* FORCE RLS" "
  SELECT c.relname || ': rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND EXISTS (SELECT 1 FROM information_schema.columns col
                WHERE col.table_schema = 'public' AND col.table_name = c.relname
                  AND col.column_name = 'business_id')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);"

expect_empty "no table has RLS enabled with no policy to enforce (which denies everything silently)" "
  SELECT c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname);"

# A policy with only USING filters reads but lets a write place a row in
# another tenant; a policy with only WITH_CHECK does the reverse. Both
# halves, or the isolation has a hole. `businesses` is the documented
# exception: it carries three per-command policies because PostgreSQL does
# not permit WITH CHECK on SELECT or USING on INSERT.
expect_empty "every policy has BOTH halves (USING and WITH CHECK)" "
  SELECT tablename || '.' || policyname || ' (' || cmd || ')'
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename <> 'businesses'
    AND NOT (qual IS NOT NULL AND with_check IS NOT NULL);"

# A policy with both halves is not automatically a policy that isolates
# anything: `USING (true)` has a USING half and lets every tenant read
# every row. Every policy outside the documented `businesses` exception
# must actually consult the session's tenant.
expect_empty "every policy actually consults app.current_tenant_id, in BOTH halves" "
  SELECT tablename || '.' || policyname || ' (' || cmd || ')'
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename <> 'businesses'
    AND NOT (qual LIKE '%app.current_tenant_id%' AND with_check LIKE '%app.current_tenant_id%');"

# `businesses` is the ONE documented exception, and it is bounded here so
# it cannot quietly grow: sign-in must resolve a slug before any tenant is
# known, so SELECT is open by design - but INSERT and UPDATE are not, and
# the row a caller may write is still pinned to their own tenant.
expect_empty "the businesses exception is exactly the three documented per-command policies" "
  SELECT 'expected 3 policies (SELECT/INSERT/UPDATE), found: ' || string_agg(cmd || ':' || policyname, ', ' ORDER BY cmd)
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'businesses'
  HAVING count(*) <> 3
      OR count(*) FILTER (WHERE cmd = 'SELECT' AND qual = 'true') <> 1
      OR count(*) FILTER (WHERE cmd = 'INSERT' AND with_check LIKE '%app.current_tenant_id%') <> 1
      OR count(*) FILTER (WHERE cmd = 'UPDATE' AND qual LIKE '%app.current_tenant_id%'
                                              AND with_check LIKE '%app.current_tenant_id%') <> 1;"

echo

# ---------------------------------------------------------------------
echo "The application role"
# ---------------------------------------------------------------------
expect_empty "$APP_ROLE is NOT a superuser and does NOT bypass RLS" "
  SELECT 'rolsuper=' || rolsuper || ' rolbypassrls=' || rolbypassrls
  FROM pg_roles WHERE rolname = '$APP_ROLE' AND (rolsuper OR rolbypassrls);"

expect_empty "$APP_ROLE exists at all" "
  SELECT 'role $APP_ROLE is missing from this cluster'
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE');"

expect_empty "no table is reachable by PUBLIC (which would sidestep the role entirely)" "
  SELECT table_name || ': ' || string_agg(DISTINCT privilege_type, ',')
  FROM information_schema.table_privileges
  WHERE table_schema = 'public' AND grantee = 'PUBLIC'
  GROUP BY table_name;"

expect_empty "$APP_ROLE holds no privilege it was never granted (TRUNCATE, REFERENCES, TRIGGER)" "
  SELECT table_name || ': ' || privilege_type
  FROM information_schema.table_privileges
  WHERE table_schema = 'public' AND grantee = '$APP_ROLE'
    AND privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE');"

echo

# ---------------------------------------------------------------------
echo "Append-only ledgers"
# ---------------------------------------------------------------------
# The authoritative list, from the approved architecture. Naming them
# explicitly (rather than deriving the list from the grants themselves)
# is the point: a table that quietly GAINED an UPDATE grant would still
# look self-consistent to a derived check.
APPEND_ONLY="stock_movements journal_entries journal_entry_lines customer_points
sale_promotion_applications sale_item_serials sale_return_item_serials
cash_transactions sale_returns sale_return_items expenses audit_logs
product_price_history purchase_receipt_item_serials purchase_return_item_serials
stock_transfer_item_serials accounting_mapping_rules customer_transactions
supplier_transactions purchase_payments sale_payments purchase_receipts
purchase_receipt_items purchase_returns purchase_return_items"
LIST="$(echo "$APPEND_ONLY" | tr -s '[:space:]' '\n' | sed "/^$/d" | sed "s/.*/'&'/" | paste -sd, -)"

expect_empty "no append-only table grants $APP_ROLE UPDATE or DELETE" "
  SELECT table_name || ': ' || privilege_type
  FROM information_schema.table_privileges
  WHERE table_schema = 'public' AND grantee = '$APP_ROLE'
    AND table_name IN ($LIST)
    AND privilege_type IN ('UPDATE', 'DELETE');"

expect_empty "every append-only table still exists and is still readable/insertable" "
  SELECT t.name || ': ' || coalesce(string_agg(p.privilege_type, ',' ORDER BY p.privilege_type), 'NO GRANTS')
  FROM (SELECT unnest(ARRAY[$LIST]) AS name) t
  LEFT JOIN information_schema.table_privileges p
    ON p.table_schema = 'public' AND p.table_name = t.name AND p.grantee = '$APP_ROLE'
  GROUP BY t.name
  HAVING coalesce(string_agg(p.privilege_type, ',' ORDER BY p.privilege_type), '') <> 'INSERT,SELECT';"

echo

# ---------------------------------------------------------------------
echo "Double-entry and ledger invariants"
# ---------------------------------------------------------------------
expect_empty "every journal entry balances to the cent" "
  SELECT je.id::text || ' debit=' || sum(l.debit) || ' credit=' || sum(l.credit)
  FROM journal_entries je JOIN journal_entry_lines l ON l.journal_entry_id = je.id
  GROUP BY je.id HAVING sum(l.debit) <> sum(l.credit);"

expect_empty "no journal line is both a debit and a credit, or neither" "
  SELECT id::text FROM journal_entry_lines
  WHERE (debit <> 0 AND credit <> 0) OR (debit = 0 AND credit = 0);"

expect_empty "every stock balance equals the sum of its movements" "
  SELECT b.id::text || ' balance=' || b.quantity_on_hand || ' movements=' || coalesce(m.total, 0)
  FROM stock_balances b
  LEFT JOIN (SELECT warehouse_id, variant_id, sum(quantity_base) AS total FROM stock_movements
             GROUP BY warehouse_id, variant_id) m
    ON m.warehouse_id = b.warehouse_id AND m.variant_id = b.variant_id
  WHERE b.quantity_on_hand <> coalesce(m.total, 0);"

# Resolved through the mapping rule rather than a hard-coded account
# code, because the code is a business's own chart-of-accounts choice while
# the mapping KEY is the system's. Every exchange debits this account by
# exactly what the paired return credited it, so a non-zero balance means a
# half-posted exchange somewhere in the book.
expect_empty "the exchange clearing account nets to zero in every business" "
  SELECT r.business_id::text || ' clearing=' || (sum(l.debit) - sum(l.credit))
  FROM accounting_mapping_rules r JOIN journal_entry_lines l ON l.account_id = r.account_id
  WHERE r.key = 'EXCHANGE_CLEARING'
  GROUP BY r.business_id HAVING sum(l.debit) - sum(l.credit) <> 0;"

expect_empty "every business actually HAS an exchange clearing mapping (an unmapped one cannot post)" "
  SELECT b.slug FROM businesses b
  WHERE NOT EXISTS (SELECT 1 FROM accounting_mapping_rules r
                    WHERE r.business_id = b.id AND r.key = 'EXCHANGE_CLEARING');"

expect_empty "no row belongs to a business that does not exist" "
  SELECT 'sales' WHERE EXISTS (SELECT 1 FROM sales s WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = s.business_id))
  UNION ALL
  SELECT 'journal_entries' WHERE EXISTS (SELECT 1 FROM journal_entries j WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = j.business_id))
  UNION ALL
  SELECT 'stock_movements' WHERE EXISTS (SELECT 1 FROM stock_movements m WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = m.business_id));"

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "PASS — nothing has drifted."
else
  echo "FAIL — $FAILURES check(s) found a problem."
fi
exit "$FAILURES"
