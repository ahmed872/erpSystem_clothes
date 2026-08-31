#!/usr/bin/env bash
# ---------------------------------------------------------------------
# Retail Operating System — logical backup
#
# Phase 11. Uses pg_dump's custom format, which is what makes selective
# restore and parallel restore possible later; a plain SQL file forecloses
# both. Deliberately NOT a filesystem snapshot: that requires stopping the
# server or a storage-layer freeze, and it captures a version-locked
# binary state that only restores onto the same PostgreSQL major version.
#
# WHAT IS CAPTURED, and why it is enough. A single dump of the whole
# database carries the schema, every row, and - critically - the RLS
# policies, the FORCE RLS flags, the CHECK constraints, and the GRANTs to
# `erp_app`. Tenant isolation and the append-only ledgers are properties of
# the schema, so they come back with it. `--no-owner` is deliberately NOT
# passed, so grants survive.
#
# WHAT IS NOT CAPTURED: the `erp_app` ROLE itself. Roles are cluster-wide,
# not per-database, so a restore onto a fresh cluster must create it first
# (see restore.sh, which checks and refuses rather than silently producing
# a database nothing can connect to).
#
# Usage:  DATABASE_URL=... ops/backup.sh [output-directory]
# ---------------------------------------------------------------------
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set (the owner connection, not RUNTIME_DATABASE_URL)}"

# Every connection string in this project carries Prisma's `?schema=public`
# query parameter. libpq rejects it outright ("invalid URI query
# parameter"), so it is stripped here rather than asking every operator to
# hand-edit a URL under incident pressure.
strip_prisma_params() {
  printf '%s' "$1" | sed -E 's/[?&]schema=[^&]*//g; s/\?$//'
}

PG_URL="$(strip_prisma_params "$DATABASE_URL")"

OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_NAME="$(printf '%s' "$PG_URL" | sed -E 's#.*/([^/?]+).*#\1#')"
FILE="${OUT_DIR}/${DB_NAME}-${STAMP}.dump"

echo "==> backing up '${DB_NAME}' to ${FILE}"
pg_dump --format=custom --compress=9 --file="$FILE" "$PG_URL"

# A dump that cannot be listed is not a backup. Verifying the table of
# contents catches a truncated or corrupt file NOW, rather than during the
# incident when it is needed.
echo "==> verifying archive is readable"
TABLES="$(pg_restore --list "$FILE" | grep -c 'TABLE DATA' || true)"
echo "    $(du -h "$FILE" | cut -f1), ${TABLES} tables with data"
if [ "$TABLES" -eq 0 ]; then
  echo "!!! archive contains no table data - refusing to report success" >&2
  exit 1
fi

echo "==> ok: ${FILE}"
