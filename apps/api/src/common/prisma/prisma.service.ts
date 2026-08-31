import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type TenantTx = Prisma.TransactionClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wraps the Prisma client used at *runtime* by the API. This client MUST
 * be constructed with RUNTIME_DATABASE_URL (the restricted `erp_app`
 * role), never DATABASE_URL (the migration/superuser role) - see
 * docs/architecture/PHASE-0-ARCHITECTURE.md §5 and migration
 * 20260828121600_lockdown_app_role. A superuser connection would
 * implicitly BYPASSRLS and silently defeat every tenant-isolation policy.
 *
 * Every tenant-scoped read/write must go through `withTenant`, which
 * opens a DB transaction and issues `SET LOCAL app.current_tenant_id`
 * before running the caller's work, so PostgreSQL Row-Level Security
 * enforces isolation at the database layer - not just via an
 * application-level `WHERE business_id = ...` that a bug could omit.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  readonly client: PrismaClient;

  constructor() {
    const url = process.env.RUNTIME_DATABASE_URL;
    if (!url) {
      throw new Error(
        'RUNTIME_DATABASE_URL is not set. The API must connect via the restricted erp_app role, not DATABASE_URL.',
      );
    }
    this.client = new PrismaClient({ datasources: { db: { url } } });
  }

  async onModuleInit() {
    await this.client.$connect();
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }

  /**
   * Runs `work` inside a transaction scoped to `tenantId`: every query
   * `work` issues via the provided `tx` is subject to the RLS policies
   * for that tenant. Use this for all authenticated, tenant-scoped
   * operations, including the initial business-onboarding transaction
   * (where `tenantId` is the freshly generated business id, set BEFORE
   * inserting the business row itself - see RegisterBusinessUseCase).
   */
  async withTenant<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) {
      // SET LOCAL cannot be parameterized (Postgres protocol limitation),
      // so we defensively validate the shape of a value that always
      // originates server-side (JWT claim or freshly generated uuid)
      // before interpolating it into raw SQL.
      throw new Error(`Invalid tenant id format: ${tenantId}`);
    }
    return this.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
      return work(tx);
    });
  }

  /**
   * Phase 12 (Sale Quote) — the same tenant scoping as `withTenant`, in a
   * transaction PostgreSQL itself will not let write.
   *
   * `SET TRANSACTION READ ONLY` is issued before any of the caller's work,
   * so every `INSERT`, `UPDATE`, `DELETE` and `SELECT ... FOR UPDATE`
   * inside it is refused by the database with
   * `ERROR: cannot execute ... in a read-only transaction`.
   *
   * WHY THAT MATTERS HERE. The sale-quote endpoint runs the SAME pricing
   * pipeline the real sale runs, so that the two can never disagree. That
   * is the right design and it carries one risk: a future change to that
   * shared code could add a write, and the quote would silently start
   * having side effects on a path nobody re-reviews. A comment asking
   * people not to do that is not a guarantee. This is: the write fails,
   * loudly, at the database, whoever wrote it and whenever.
   *
   * It is not a substitute for the quote being read-only by construction -
   * it is what makes that property enforced rather than promised.
   */
  async withTenantReadOnly<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error(`Invalid tenant id format: ${tenantId}`);
    }
    return this.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
      return work(tx);
    });
  }

  /**
   * Runs `work` in a transaction with NO tenant context set. Only the
   * `businesses` table's public SELECT policy is reachable here (see
   * migration 20260828121500_enable_row_level_security) - every other
   * tenant-scoped table denies all rows by default. Use only for
   * pre-authentication lookups such as resolving a business by slug.
   */
  async withoutTenant<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => work(tx));
  }
}
