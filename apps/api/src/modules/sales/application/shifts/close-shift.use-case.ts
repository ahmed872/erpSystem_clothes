import { Injectable } from '@nestjs/common';
import type { CloseShiftInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { AccountingEngineService } from '../../../../engines/accounting/accounting-engine.service';
import { buildCashVarianceJournalLines } from '../../../accounting/domain/cash-variance-journal-lines';
import { computeShiftCash, applyExpectedCashVisibility } from '../../../finance/domain/shift-cash';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';

/**
 * Phase 10 (BD-17 rules 4–7) — BLIND CLOSE.
 *
 * The cashier submits what they physically counted. They are not shown the
 * expected figure beforehand (the shift read endpoints strip it for anyone
 * without `shifts.view_expected`), and the number they submit is stored
 * exactly as given: rule 6 is honoured by there being no code path anywhere
 * that recomputes, rounds away or overwrites `countedCash` after this
 * point. The manager's later reconciliation records an acknowledgement, not
 * a correction.
 *
 * The variance posts to the ledger HERE, at close, because that is the
 * moment the counted amount becomes a fact. Deferring the posting to
 * reconciliation would leave the books knowingly wrong for as long as
 * nobody got round to reviewing, and rule 9 explicitly allows a shift to
 * close with a variance and no approval.
 *
 * CONCURRENCY: the shift row is taken with `SELECT ... FOR UPDATE` before
 * the cash ledger is summed, so a tender or pay-out cannot be inserted
 * between computing expected cash and writing the close. Two concurrent
 * closes serialize on the same lock and the second sees CLOSED.
 */
@Injectable()
export class CloseShiftUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accounting: AccountingEngineService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, input: CloseShiftInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const locked = await tx.$queryRawUnsafe<{ id: string; status: string }[]>(
        `SELECT id, status::text AS status
           FROM shifts
          WHERE business_id = $1 AND opened_by = $2 AND status = 'OPEN'
            FOR UPDATE`,
        actor.tenantId,
        actor.id,
      );
      if (locked.length === 0) {
        throw new ConflictDomainError('You have no open shift to close');
      }

      const openShift = await tx.shift.findUniqueOrThrow({ where: { id: locked[0].id } });
      const cash = await computeShiftCash(tx, actor.tenantId, openShift);
      const countedCash = input.countedCash;

      const result = await tx.shift.updateMany({
        where: { id: openShift.id, status: 'OPEN' },
        data: { status: 'CLOSED', closedBy: actor.id, closedAt: new Date(), countedCash },
      });
      if (result.count === 0) {
        throw new ConflictDomainError('This shift was already closed');
      }

      const closed = await tx.shift.findUniqueOrThrow({ where: { id: openShift.id } });
      const variance = closed.countedCash!.minus(cash.expectedCash);

      // Rule 7: the variance reaches the books through the AccountingEngine
      // like every other financial fact - never a direct journal write. A
      // zero variance posts nothing at all.
      const lines = await buildCashVarianceJournalLines(tx, actor.tenantId, variance);
      if (lines.length > 0) {
        await this.accounting.postEntry(tx, {
          businessId: actor.tenantId,
          entryDate: closed.closedAt ?? new Date(),
          sourceType: 'Shift',
          sourceId: closed.id,
          description: `Cash variance on shift close (${variance.isNegative() ? 'shortage' : 'overage'})`,
          createdBy: actor.id,
          lines,
        });
      }

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Shift',
        entityId: closed.id,
        before: { status: 'OPEN' },
        after: {
          status: 'CLOSED',
          countedCash: closed.countedCash?.toString(),
          expectedCash: cash.expectedCash.toString(),
          variance: variance.toString(),
        },
        reason: input.notes ?? 'Shift closed',
      });

      // Rule 4 is "not before submission", but the expected figure stays
      // behind `shifts.view_expected` even in the close response: a cashier
      // who learns the expected amount after each close learns it for every
      // future close, which would hollow out blind counting over time. The
      // fields are REMOVED, not nulled, so the till device never receives
      // them at all.
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      return applyExpectedCashVisibility(
        {
          ...closed,
          openingFloat: closed.openingFloat.toString(),
          countedCash: closed.countedCash?.toString() ?? null,
          cashIn: cash.cashIn.toString(),
          cashOut: cash.cashOut.toString(),
          expectedCash: cash.expectedCash.toString(),
          variance: variance.toString(),
        },
        permissions?.has('shifts.view_expected') ?? false,
      );
    });
  }
}
