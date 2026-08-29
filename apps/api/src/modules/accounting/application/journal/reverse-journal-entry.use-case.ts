import { Injectable } from '@nestjs/common';
import type { ReverseJournalEntryInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { AccountingEngineService } from '../../../../engines/accounting/accounting-engine.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * The one and only correction mechanism for a posted journal entry
 * (Phase 0 §6.2) - never an edit. Works on ANY posted entry, automatic
 * or (in a future phase) manual alike, since AccountingEngineService
 * itself owns the reversal mechanics (swap debit/credit, DB-enforced
 * at-most-once via the (businessId, reversalOfId) unique constraint).
 */
@Injectable()
export class ReverseJournalEntryUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accounting: AccountingEngineService,
  ) {}

  async execute(actor: RequestUser, journalEntryId: string, input: ReverseJournalEntryInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const reversal = await this.accounting.reverseEntry(tx, actor.tenantId, journalEntryId, actor.id, input.reason);

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'JournalEntry',
        entityId: reversal.id,
        after: reversal,
        reason: input.reason ?? `Reversal of journal entry ${journalEntryId}`,
      });

      return reversal;
    });
  }
}
