import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class GetJournalEntryUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, journalEntryId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const entry = await tx.journalEntry.findFirst({
        where: { id: journalEntryId, businessId: actor.tenantId },
        include: { lines: { include: { account: { select: { id: true, code: true, name: true } } } }, reversedBy: true, reversalOf: true },
      });
      if (!entry) throw new NotFoundDomainError('JournalEntry', journalEntryId);
      return entry;
    });
  }
}
