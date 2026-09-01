import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CustomerListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { getCustomerBalance } from '../../domain/customer-balance';

/**
 * Phase 12 (POS loose ends, approved decision D1) — a till finds a
 * customer by NAME OR PHONE, and an exact phone wins.
 *
 * WHY PHONE AT ALL. At a counter the customer says their number, not
 * their spelling. Searching names only meant a cashier with a phone number
 * in hand had no way to reach an existing account, so they created a
 * duplicate — which then splits that customer's loyalty balance and their
 * ledger across two records.
 *
 * WHY EXACT FIRST, AND WHY IT IS DONE IN SQL. A shop with "0100" and
 * "01001234567" on file must not bury the person who just read out their
 * whole number under everyone whose number merely contains it. Ranking
 * only the fetched page would leave an exact match stranded on page three,
 * so the ordering is expressed where the paging happens: Postgres orders
 * by the match, and the page is cut from an already-correct sequence.
 * `COALESCE(phone = $exact, false)` rather than a bare comparison because
 * a NULL phone would otherwise sort FIRST under `DESC NULLS FIRST` and put
 * customers with no number at all above the person standing at the till.
 *
 * TENANT ISOLATION IS UNCHANGED: the query runs inside `withTenant`, so
 * RLS applies, and `business_id` is in the predicate as well - the same
 * defence-in-depth every other read here uses. The ILIKE pattern is bound
 * as a parameter, never interpolated.
 */
@Injectable()
export class ListCustomersUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, query: CustomerListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const term = query.search?.trim();

      if (!term) {
        return this.unsearched(tx, actor, query);
      }

      // `contains` semantics, identical to what name search did before —
      // widened to phone. Escaped so a customer typing '%' searches for a
      // literal '%' rather than matching everybody.
      const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const isActive = query.isActive === undefined ? null : query.isActive;
      const offset = (query.page - 1) * query.limit;

      const [rows, counted] = await Promise.all([
        tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM customers
           WHERE business_id = ${actor.tenantId}
             AND (${isActive}::boolean IS NULL OR is_active = ${isActive}::boolean)
             AND (name ILIKE ${pattern} OR phone ILIKE ${pattern})
           ORDER BY COALESCE(phone = ${term}, false) DESC, name ASC
           LIMIT ${query.limit} OFFSET ${offset}`,
        tx.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) AS count FROM customers
           WHERE business_id = ${actor.tenantId}
             AND (${isActive}::boolean IS NULL OR is_active = ${isActive}::boolean)
             AND (name ILIKE ${pattern} OR phone ILIKE ${pattern})`,
      ]);

      const total = Number(counted[0]?.count ?? 0);
      const ids = rows.map((r) => r.id);
      const customers = await tx.customer.findMany({ where: { id: { in: ids }, businessId: actor.tenantId } });
      // `findMany` does not preserve the ranked order, so it is reapplied
      // from the ids the ordered query returned.
      const byId = new Map(customers.map((c) => [c.id, c]));
      const ordered = ids.map((id) => byId.get(id)).filter((c): c is (typeof customers)[number] => Boolean(c));

      return this.withBalances(tx, actor, ordered, query, total);
    });
  }

  /** The unchanged listing path: no search term, no ranking to do. */
  private async unsearched(tx: Prisma.TransactionClient, actor: RequestUser, query: CustomerListQuery) {
    const where = { businessId: actor.tenantId, isActive: query.isActive };
    const [total, customers] = await Promise.all([
      tx.customer.count({ where }),
      tx.customer.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return this.withBalances(tx, actor, customers, query, total);
  }

  private async withBalances(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    customers: { id: string }[],
    query: CustomerListQuery,
    total: number,
  ) {
    const data = await Promise.all(
      customers.map(async (c) => ({ ...c, balance: (await getCustomerBalance(tx as never, actor.tenantId, c.id)).toString() })),
    );
    return {
      data,
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }
}
