import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TrialBalanceQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Every account's live balance, derived directly from JournalEntryLine
 * (Phase 0 §6.5: reports are derived from JournalEntryLine, never a
 * separate summary table) - plus the explicit totalDebit=totalCredit
 * check surfaced on the response itself, the direct proof of Phase 6's
 * own core invariant (§D), the same posture Inventory's
 * /inventory/reconciliation endpoint already established for its own
 * domain.
 */
@Injectable()
export class GetTrialBalanceUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, query: TrialBalanceQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const accounts = await tx.account.findMany({ where: { businessId: actor.tenantId }, orderBy: { code: 'asc' } });

      const lineWhere: Prisma.JournalEntryLineWhereInput = { businessId: actor.tenantId };
      if (query.fiscalPeriodId) {
        lineWhere.journalEntry = { fiscalPeriodId: query.fiscalPeriodId };
      }

      const grouped = await tx.journalEntryLine.groupBy({
        by: ['accountId'],
        where: lineWhere,
        _sum: { debit: true, credit: true },
      });
      const byAccountId = new Map(grouped.map((g) => [g.accountId, g._sum]));

      let totalDebit = new Prisma.Decimal(0);
      let totalCredit = new Prisma.Decimal(0);
      const rows = accounts.map((account) => {
        const sums = byAccountId.get(account.id);
        const debit = sums?.debit ?? new Prisma.Decimal(0);
        const credit = sums?.credit ?? new Prisma.Decimal(0);
        totalDebit = totalDebit.plus(debit);
        totalCredit = totalCredit.plus(credit);
        const balance = account.normalBalance === 'DEBIT' ? debit.minus(credit) : credit.minus(debit);
        return {
          accountId: account.id,
          code: account.code,
          name: account.name,
          type: account.type,
          normalBalance: account.normalBalance,
          totalDebit: debit.toString(),
          totalCredit: credit.toString(),
          balance: balance.toString(),
        };
      });

      return {
        accounts: rows,
        totalDebit: totalDebit.toString(),
        totalCredit: totalCredit.toString(),
        balanced: totalDebit.equals(totalCredit),
      };
    });
  }
}
