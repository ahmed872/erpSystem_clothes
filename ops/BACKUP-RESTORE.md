# Backup and restore

Phase 11. This procedure was **executed against a real PostgreSQL 16
database**, not written from memory — the verification output is recorded
at the end.

## What this is, and what it is not

`pg_dump` in custom format, and `pg_restore`. That is the whole mechanism.
It is deliberately the smallest thing that works, because a backup story
nobody exercises is not a backup story, and the more moving parts it has
the less often it gets exercised.

It is **not** a filesystem snapshot: that needs the server stopped or a
storage-layer freeze, and it produces a version-locked binary image that
only restores onto the same PostgreSQL major version. It is **not**
point-in-time recovery: PITR needs WAL archiving, which is a property of
the *deployment*, not of this repository. See "What is still needed for
production" below.

## Why a schema dump is enough for tenant isolation

The three properties that make this system safe are all **schema**, not
application code:

| Property | Where it lives | In the dump? |
|---|---|---|
| Tenant isolation | RLS policies + FORCE RLS on every tenant table | Yes |
| Append-only ledgers | `GRANT SELECT, INSERT` and nothing more to `erp_app` | Yes |
| Financial invariants | CHECK constraints and the double-entry trigger | Yes |

So a restored database is not merely a copy of the rows — it is a copy of
the enforcement. `restore.sh` verifies all three before reporting success,
because a restore that brought back the data and lost RLS would be a
silent, total tenant-isolation failure.

**One thing is not in the dump: the `erp_app` role.** Roles are
cluster-wide, not per-database. `restore.sh` checks for it and refuses
rather than producing a database the API cannot connect to.

## Taking a backup

```bash
DATABASE_URL=postgresql://postgres:...@host:5432/erp_prod ops/backup.sh /var/backups/erp
```

Uses the **owner** connection, not `RUNTIME_DATABASE_URL`: `erp_app` is
subject to RLS and would dump only the rows of whichever tenant happened
to be set, which is a backup that looks fine and is empty.

The script fails if the resulting archive contains no table data. A dump
that cannot be listed is not a backup, and the time to discover that is
now rather than during the incident.

## Restoring

```bash
createdb erp_restored
TARGET_URL=postgresql://postgres:...@host:5432/erp_restored ops/restore.sh /var/backups/erp/erp_prod-....dump
```

The target must exist and be **empty**. The script refuses otherwise: a
restore is not a merge, and `pg_restore` into a populated database
produces a mixture of old and new rows with duplicate-key errors scattered
through it — far worse than a clean failure.

To cut over, restore into a new database and repoint
`RUNTIME_DATABASE_URL`. Do not restore over the live database.

## Verification actually performed

Source: `erp_test` after a full exchange suite run — 2 tenants, 47 sales,
67 journal entries, 295 journal lines, 122 stock movements, 247 audit rows.
Restored into a freshly created `erp_restored` on the same cluster.

```
row-for-row equality, source vs restored
  businesses  2 · users 3 · sales 47 · sale_items 47
  journal_entries 67 · journal_entry_lines 295 · stock_movements 122
  customer_points 3 · audit_logs 247 · cash_transactions 44      ALL MATCH

financial invariants survived
  unbalanced entries:          0
  exchange clearing balance:   0.0000
  balance vs movement drift:   0

tenant isolation, as the restricted erp_app role
  as tenant A: own sales 46, tenant B's sales 0
  as tenant B: own sales  1, tenant A's sales 0

enforcement still live
  DELETE FROM journal_entry_lines  ->  ERROR: permission denied
  UPDATE audit_logs                ->  ERROR: permission denied
  INSERT for another tenant        ->  ERROR: new row violates RLS policy
  rows after all three attempts    ->  295 lines, 0 tampered, 0 smuggled
```

**Restore was demonstrated, not asserted.**

## What is still needed for production, and is not in this repository

These are deployment contracts, not code. They are named here rather than
faked, and none of them is invented — no provider, credential or bucket
appears anywhere in this repository.

1. **Where the archives go.** `backup.sh` writes to a local directory.
   Production needs off-host, versioned, encrypted-at-rest storage with a
   retention policy. The contract: a durable object store, write access for
   the backup job, and no read access from the application host.
2. **A schedule.** A cron or scheduled job invoking `backup.sh`. Frequency
   follows the acceptable data loss window, which is a business decision
   nobody has made yet.
3. **Point-in-time recovery.** `pg_dump` recovers to the moment of the
   dump. Recovering to the moment *before* an incident needs continuous WAL
   archiving — a managed-Postgres feature or an explicit `archive_command`.
4. **A restore rehearsal on a schedule.** The procedure above was executed
   once, here. An untested backup decays into a broken one; the only way to
   know it still works is to run it.
5. **Role provisioning.** `erp_app` must exist on the target cluster with
   `NOSUPERUSER NOBYPASSRLS`. Belongs in infrastructure provisioning.
