import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Live SUM(debit)-SUM(credit) (or the reverse, per the account's own
 * normalBalance) for one account - NEVER a stored/mutable balance
 * column, exactly the same derivation principle CustomerTransaction/
 * SupplierTransaction balances already use (Phase 0 §10 rule #6).
 */
@Injectable()
export class GetAccountBalanceUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, accountId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const account = await tx.account.findFirst({ where: { id: accountId, businessId: actor.tenantId } });
      if (!account) throw new NotFoundDomainError('Account', accountId);

      const agg = await tx.journalEntryLine.aggregate({
        where: { businessId: actor.tenantId, accountId },
        _sum: { debit: true, credit: true },
      });
      const totalDebit = agg._sum.debit ?? new Prisma.Decimal(0);
      const totalCredit = agg._sum.credit ?? new Prisma.Decimal(0);
      const balance = account.normalBalance === 'DEBIT' ? totalDebit.minus(totalCredit) : totalCredit.minus(totalDebit);

      return {
        accountId: account.id,
        code: account.code,
        name: account.name,
        type: account.type,
        normalBalance: account.normalBalance,
        totalDebit: totalDebit.toString(),
        totalCredit: totalCredit.toString(),
        balance: balance.toString(),
      };
    });
  }
}
