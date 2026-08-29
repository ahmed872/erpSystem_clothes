import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { TenantTx } from '../../common/prisma/prisma.service';
import { NotFoundDomainError, UnbalancedJournalEntryError, ValidationFailedError } from '../../common/errors/domain-error';
import { documentNumberFromId } from '../../common/domain/document-number';
import { lockFiscalPeriodCoveringDate } from '../../modules/accounting/domain/lock-fiscal-period';

export interface PostEntryLineInput {
  accountId: string;
  debit?: Prisma.Decimal.Value;
  credit?: Prisma.Decimal.Value;
  description?: string;
}

export interface PostEntryParams {
  businessId: string;
  entryDate: Date;
  sourceType: string;
  sourceId: string;
  description?: string;
  createdBy?: string;
  lines: PostEntryLineInput[];
}

interface NormalizedLine {
  accountId: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  description?: string;
}

/**
 * The ONLY interface through which an automatic journal entry is ever
 * created (Phase 0 §6: "لا يُستدعى إلا عبر واجهة واحدة:
 * AccountingEngine.postEntry(...)"). Never called from a controller -
 * only from an application-layer use-case, inside the SAME DB
 * transaction as the business event it represents, so a failed posting
 * rolls back the business event too, and vice versa.
 *
 * Deliberately dumb/generic: it does not know what a "Sale" or a
 * "Purchase" is, does not resolve AccountingMappingRule keys to account
 * ids, and does not compute any business amount - it only validates and
 * inserts already-resolved, already-computed lines. Every domain-specific
 * concern (which accounts, which amounts) lives in the calling
 * use-case's own small "build the lines" step, which itself calls
 * resolveMappedAccounts (see modules/accounting/domain) to turn
 * AccountingMappingKey values into real Account ids. This split keeps
 * the posting logic auditable in the use-case that owns the business
 * fact, not hidden inside a generic rules-interpreter (Phase 6
 * pre-implementation review, integration boundaries).
 */
@Injectable()
export class AccountingEngineService {
  async postEntry(tx: TenantTx, params: PostEntryParams) {
    const normalizedLines = this.normalizeAndValidateLines(params.lines);
    return this.insertEntry(tx, {
      businessId: params.businessId,
      entryDate: params.entryDate,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      description: params.description,
      createdBy: params.createdBy,
      reversalOfId: null,
      lines: normalizedLines,
    });
  }

  /**
   * Corrections are new reversal entries only, never edits (Phase 0
   * §6.2) - the original entry is never mutated (journal_entries has no
   * UPDATE grant for erp_app at all, by design). "Has this entry been
   * reversed" is therefore always a DERIVED fact (does a row exist with
   * reversalOfId = this entry's id), never a stored status flip -
   * JournalEntryStatus.REVERSED is consequently never actually written
   * by any Phase 6 code path (see PROJECT_STATE.md). Duplicate-reversal
   * protection is the (businessId, reversalOfId) unique constraint -
   * DB-enforced, not an application pre-check alone.
   */
  async reverseEntry(tx: TenantTx, businessId: string, originalEntryId: string, actorId?: string, reason?: string) {
    const original = await tx.journalEntry.findFirst({ where: { id: originalEntryId, businessId }, include: { lines: true } });
    if (!original) throw new NotFoundDomainError('JournalEntry', originalEntryId);

    const alreadyReversed = await tx.journalEntry.findFirst({ where: { businessId, reversalOfId: original.id } });
    if (alreadyReversed) {
      throw new ValidationFailedError('This journal entry has already been reversed', { journalEntryId: original.id, reversalId: alreadyReversed.id });
    }

    // Swapped: what was a debit becomes a credit and vice versa - the
    // exact mirror image, guaranteed balanced since the original was.
    const reversalLines = this.normalizeAndValidateLines(
      original.lines.map((line) => ({ accountId: line.accountId, debit: line.credit, credit: line.debit, description: line.description ?? undefined })),
    );

    return this.insertEntry(tx, {
      businessId,
      entryDate: new Date(),
      sourceType: 'JournalEntry',
      sourceId: original.id,
      description: reason ?? `Reversal of ${original.entryNumber}`,
      createdBy: actorId,
      reversalOfId: original.id,
      lines: reversalLines,
    });
  }

  private normalizeAndValidateLines(lines: PostEntryLineInput[]): NormalizedLine[] {
    if (lines.length < 2) {
      throw new ValidationFailedError('A journal entry needs at least two lines');
    }

    const normalized = lines.map((line) => {
      const debit = new Prisma.Decimal(line.debit ?? 0);
      const credit = new Prisma.Decimal(line.credit ?? 0);
      if (debit.isNegative() || credit.isNegative()) {
        throw new ValidationFailedError('A journal line cannot have a negative debit or credit', { accountId: line.accountId });
      }
      const debitPositive = debit.greaterThan(0);
      const creditPositive = credit.greaterThan(0);
      if (debitPositive === creditPositive) {
        // Both zero, or both positive - either way not a valid single-sided line.
        throw new ValidationFailedError('Each journal line must be either a debit or a credit, never both, never neither', {
          accountId: line.accountId,
          debit: debit.toString(),
          credit: credit.toString(),
        });
      }
      return { accountId: line.accountId, debit, credit, description: line.description };
    });

    const totalDebit = normalized.reduce((sum, l) => sum.plus(l.debit), new Prisma.Decimal(0));
    const totalCredit = normalized.reduce((sum, l) => sum.plus(l.credit), new Prisma.Decimal(0));
    if (!totalDebit.equals(totalCredit)) {
      throw new UnbalancedJournalEntryError(
        `Journal entry is not balanced: total debit ${totalDebit.toString()} does not equal total credit ${totalCredit.toString()}`,
        { totalDebit: totalDebit.toString(), totalCredit: totalCredit.toString() },
      );
    }

    return normalized;
  }

  private async insertEntry(
    tx: TenantTx,
    params: {
      businessId: string;
      entryDate: Date;
      sourceType: string;
      sourceId: string;
      description?: string;
      createdBy?: string;
      reversalOfId: string | null;
      lines: NormalizedLine[];
    },
  ) {
    const accountIds = [...new Set(params.lines.map((l) => l.accountId))];
    const accounts = await tx.account.findMany({ where: { id: { in: accountIds }, businessId: params.businessId } });
    if (accounts.length !== accountIds.length) {
      const found = new Set(accounts.map((a) => a.id));
      throw new NotFoundDomainError('Account', accountIds.filter((id) => !found.has(id)).join(', '));
    }
    const inactive = accounts.filter((a) => !a.isActive);
    if (inactive.length > 0) {
      throw new ValidationFailedError('Cannot post to an inactive account', { accountIds: inactive.map((a) => a.id) });
    }

    // Locks the covering FiscalPeriod row FIRST (before any insert) so a
    // concurrent period-close can never interleave with this posting -
    // see lockFiscalPeriodCoveringDate's own doc comment.
    const period = await lockFiscalPeriodCoveringDate(tx, params.businessId, params.entryDate);
    if (period.status !== 'OPEN') {
      throw new ValidationFailedError('This date falls within a closed fiscal period', { entryDate: params.entryDate.toISOString() });
    }

    const id = randomUUID();
    const entry = await tx.journalEntry.create({
      data: {
        id,
        businessId: params.businessId,
        fiscalPeriodId: period.id,
        entryNumber: documentNumberFromId('JE', id),
        entryDate: params.entryDate,
        status: 'POSTED',
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        reversalOfId: params.reversalOfId,
        description: params.description,
        postedBy: params.createdBy,
        postedAt: new Date(),
        createdBy: params.createdBy,
      },
    });

    for (const line of params.lines) {
      await tx.journalEntryLine.create({
        data: {
          businessId: params.businessId,
          journalEntryId: entry.id,
          accountId: line.accountId,
          debit: line.debit,
          credit: line.credit,
          description: line.description,
        },
      });
    }

    return tx.journalEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { lines: true } });
  }
}
