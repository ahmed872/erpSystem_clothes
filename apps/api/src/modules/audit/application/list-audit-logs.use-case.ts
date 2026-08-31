import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuditLogListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

/**
 * Phase 11 — the audit trail, readable at last.
 *
 * Every module has written to `audit_logs` since Phase 1 and the
 * `audit.view` permission has existed just as long, but nothing ever
 * served it: the record was being kept and could not be read through the
 * API. A trail nobody can consult is a trail nobody can rely on.
 *
 * WHAT MAKES THIS SAFE TO EXPOSE, and why it needed no new protection:
 *
 *   - `audit_logs` carries RLS and FORCE RLS, so this query cannot see
 *     another tenant's rows even if the WHERE clause were wrong. The
 *     `businessId` filter below is belt to the database's braces.
 *   - `erp_app` holds SELECT and INSERT on the table and nothing else, so
 *     no read path can become a write path and no endpoint could ever be
 *     added that edits or deletes a row.
 *
 * ORDERING IS DETERMINISTIC AND MUST STAY SO. `createdAt` alone is not
 * unique - several rows are written inside one transaction and share a
 * timestamp - so paging on it alone would silently skip and repeat rows
 * across pages. `id` breaks the tie.
 */
@Injectable()
export class ListAuditLogsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, query: AuditLogListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const where: Prisma.AuditLogWhereInput = {
        businessId: actor.tenantId,
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.requestId ? { requestId: query.requestId } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      };

      const [total, data] = await Promise.all([
        tx.auditLog.count({ where }),
        tx.auditLog.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      return { data, meta: { total, page: query.page, limit: query.limit } };
    });
  }
}
