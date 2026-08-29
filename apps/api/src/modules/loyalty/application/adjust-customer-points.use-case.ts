import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AdjustCustomerPointsInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ConflictDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';
import { getCustomerPointsBalance } from '../domain/customer-points-balance';
import { lockCustomer } from '../domain/lock-customer';
import { assertIdempotentReplayMatches } from '../../../common/domain/idempotency';

function adjustmentFingerprint(customerId: string, points: Prisma.Decimal.Value, reason: string) {
  return { customerId, points: new Prisma.Decimal(points).toString(), reason };
}

/**
 * The one human-entered write to the loyalty ledger. Machine-generated
 * EARN / REDEEM / RETURN_CLAWBACK rows come from a Sale or SaleReturn and
 * are Phase 8C/8E's approved scope; this endpoint exists so a business can
 * correct a balance (goodwill grant, a mis-keyed earlier event) without
 * anyone ever needing to edit history.
 *
 * It is an INSERT, never an update: a correction is a new compensating
 * row, so the original event survives and the ledger still explains the
 * balance it produces. `erp_app` has no UPDATE or DELETE privilege on the
 * table, so that is enforced by the database, not by this class.
 *
 * NEGATIVE BALANCES ARE IMPOSSIBLE (approved policy: "لا تسمح بـ negative
 * loyalty balance ... لا تنشئ debt/negative-points mechanism"). A
 * deduction larger than the current balance is rejected 409. The check is
 * made while holding a `FOR UPDATE` lock on the CUSTOMER row and the
 * balance is re-read under that lock, so two concurrent deductions that
 * are each individually affordable can never together overdraw - locking
 * the ledger rows would not achieve this, since a row lock cannot block
 * the INSERT of a new row.
 *
 * `idempotencyKey` is REQUIRED here (unlike Sales' optional keys): there
 * is no source document behind a manual adjustment, so a double-submitted
 * request would otherwise be indistinguishable from two deliberate
 * identical grants. The DB-level `(business_id, idempotency_key)` unique
 * index is the real guarantee; the lookup below only turns a replay into
 * a friendly 200 instead of a raw unique violation, and
 * `assertIdempotentReplayMatches` rejects the same key reused with a
 * DIFFERENT payload rather than silently returning the earlier row.
 */
@Injectable()
export class AdjustCustomerPointsUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, customerId: string, input: AdjustCustomerPointsInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const existing = await tx.customerPoints.findFirst({
        where: { businessId: actor.tenantId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        assertIdempotentReplayMatches(
          adjustmentFingerprint(existing.customerId, existing.points, existing.description ?? ''),
          adjustmentFingerprint(customerId, input.points, input.reason),
        );
        return existing;
      }

      // Locks the customer AND proves it belongs to this tenant (404
      // otherwise) before any balance is read.
      await lockCustomer(tx, actor.tenantId, customerId);

      const points = new Prisma.Decimal(input.points);
      if (points.isZero()) {
        // Also guarded by the zod schema and the customer_points_nonzero
        // CHECK; kept here so the rejection is a clean domain error.
        throw new ConflictDomainError('A zero-point adjustment records nothing', { customerId });
      }

      const balance = await getCustomerPointsBalance(tx, actor.tenantId, customerId);
      const newBalance = balance.plus(points);
      if (newBalance.lessThan(0)) {
        throw new ConflictDomainError(
          `Cannot remove ${points.negated().toString()} points - the customer's balance is only ${balance.toString()}`,
          { customerId, currentBalance: balance.toString(), requested: points.toString() },
        );
      }

      const row = await tx.customerPoints.create({
        data: {
          businessId: actor.tenantId,
          customerId,
          type: 'ADJUSTMENT',
          points,
          // basisAmount/rateSnapshot stay NULL: a manual adjustment is not
          // derived from a merchandise amount at a rate, and inventing one
          // would make the row look like a computed EARN it is not. The
          // customer_points_snapshot_complete CHECK accepts both-null.
          description: input.reason,
          idempotencyKey: input.idempotencyKey,
          createdBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'CustomerPoints',
        entityId: row.id,
        after: row,
        reason: `Manual loyalty adjustment: ${input.reason}`,
      });

      return row;
    });
  }
}
