import { Injectable } from '@nestjs/common';
import type { ReconcileShiftInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { computeShiftCash } from '../../../finance/domain/shift-cash';

/**
 * Phase 10 (BD-17 rule 5) — the manager's review of a closed shift.
 *
 * This is an ACKNOWLEDGEMENT, deliberately not a correction. It records
 * WHO accepted the variance and WHEN, plus an optional note. There is no
 * field here — and no code path anywhere — that can change the cashier's
 * counted amount or alter the journal entry already posted at close. That
 * is rule 6 ("the system must NOT silently alter the cashier's counted
 * amount") expressed structurally rather than as a promise.
 *
 * Because the variance already reached the ledger at close, reconciliation
 * posts nothing. Re-posting here would double-count it; posting only here
 * would leave the books knowingly wrong until somebody reviewed.
 *
 * A shift may be reconciled once. A second attempt is rejected rather than
 * silently overwriting the first reviewer's name, so the record of who
 * accepted the variance stays truthful.
 */
@Injectable()
export class ReconcileShiftUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, shiftId: string, input: ReconcileShiftInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const locked = await tx.$queryRawUnsafe<{ id: string; status: string; reconciled_by: string | null }[]>(
        `SELECT id, status::text AS status, reconciled_by
           FROM shifts
          WHERE business_id = $1 AND id = $2
            FOR UPDATE`,
        actor.tenantId,
        shiftId,
      );
      const row = locked[0];
      if (!row) throw new NotFoundDomainError('Shift', shiftId);
      if (row.status !== 'CLOSED') {
        throw new ConflictDomainError('Only a closed shift can be reconciled', { shiftId, status: row.status });
      }
      if (row.reconciled_by !== null) {
        throw new ConflictDomainError('This shift has already been reconciled', { shiftId });
      }

      const before = await tx.shift.findUniqueOrThrow({ where: { id: shiftId } });
      const cash = await computeShiftCash(tx, actor.tenantId, before);

      const reconciled = await tx.shift.update({
        where: { id: shiftId },
        data: {
          reconciledBy: actor.id,
          reconciledAt: new Date(),
          reconciliationNote: input.note,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Shift',
        entityId: shiftId,
        before: { reconciledBy: null },
        after: {
          reconciledBy: actor.id,
          expectedCash: cash.expectedCash.toString(),
          countedCash: cash.countedCash?.toString() ?? null,
          variance: cash.variance?.toString() ?? null,
        },
        reason: input.note ?? 'Shift variance reconciled',
      });

      // The reconciling caller necessarily holds `shifts.reconcile`, and the
      // whole point of the review is to see what they are accepting, so the
      // cash figures are returned in full here. The permission matrix grants
      // `shifts.reconcile` and `shifts.view_expected` together for exactly
      // this reason.
      return {
        ...reconciled,
        openingFloat: reconciled.openingFloat.toString(),
        countedCash: reconciled.countedCash?.toString() ?? null,
        cashIn: cash.cashIn.toString(),
        cashOut: cash.cashOut.toString(),
        expectedCash: cash.expectedCash.toString(),
        variance: cash.variance?.toString() ?? null,
      };
    });
  }
}
