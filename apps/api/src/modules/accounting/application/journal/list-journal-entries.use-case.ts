import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { JournalEntryListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class ListJournalEntriesUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, query: JournalEntryListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const where: Prisma.JournalEntryWhereInput = {
        businessId: actor.tenantId,
        sourceType: query.sourceType,
        fiscalPeriodId: query.fiscalPeriodId,
        lines: query.accountId ? { some: { accountId: query.accountId } } : undefined,
      };

      const [total, entries] = await Promise.all([
        tx.journalEntry.count({ where }),
        tx.journalEntry.findMany({
          where,
          include: { lines: true },
          orderBy: { entryDate: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      return { data: entries, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
    });
  }
}
