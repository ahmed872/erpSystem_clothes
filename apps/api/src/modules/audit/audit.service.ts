import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { TenantTx } from '../../common/prisma/prisma.service';

export interface AuditEntry {
  businessId: string;
  userId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Writes append-only audit rows. Always called with the SAME `tx` used
 * for the business mutation it documents, so the audit row commits or
 * rolls back atomically with the change it describes - a sensitive
 * action can never "succeed silently" without a trail, and a rolled-back
 * action never leaves a stray audit row behind either.
 *
 * The database grants for `erp_app` only allow SELECT/INSERT on
 * audit_logs (see migration 20260828121600_lockdown_app_role) - there is
 * no application code path that could UPDATE or DELETE a row here even
 * if it tried.
 */
@Injectable()
export class AuditService {
  async record(tx: TenantTx, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        businessId: entry.businessId,
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: entry.before === undefined ? Prisma.JsonNull : (entry.before as Prisma.InputJsonValue),
        after: entry.after === undefined ? Prisma.JsonNull : (entry.after as Prisma.InputJsonValue),
        reason: entry.reason ?? null,
        requestId: entry.requestId ?? null,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  }
}
