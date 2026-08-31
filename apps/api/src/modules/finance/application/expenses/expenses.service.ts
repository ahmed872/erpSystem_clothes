import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type {
  CreateExpenseCategoryInput,
  UpdateExpenseCategoryInput,
  CreateExpenseInput,
  ExpenseListQuery,
} from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { AccountingEngineService } from '../../../../engines/accounting/accounting-engine.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { assertIdempotentReplayMatches } from '../../../../common/domain/idempotency';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { findActiveShift } from '../../../sales/domain/find-active-shift';
import { documentNumberFromId } from '../../../../common/domain/document-number';
import { recordCashTransaction } from '../../domain/record-cash-transaction';
import { buildExpenseJournalLines } from '../../../accounting/domain/expense-journal-lines';

/**
 * Phase 10 (10H) — money leaving the business for something other than
 * stock.
 *
 * THE ONE THING THAT MAKES THIS MORE THAN A FORM: a CASH expense is also a
 * movement of physical money, so it enters the shift's drawer ledger in the
 * SAME transaction as the expense that caused it. Without that, paying the
 * window cleaner out of the till would show up at blind close as a shortage
 * the cashier could not explain - and the whole point of BD-17's derived
 * expected cash is that the drawer can never disagree with the documents.
 *
 * Which GL account an expense lands in is the BUSINESS's decision, carried
 * on the category, because no product can know what a given shop counts as
 * rent, fuel or cleaning. The account is required to be EXPENSE-type: the
 * point of the feature is to record spending, and letting a category debit
 * Revenue or Inventory would corrupt the very statements it feeds.
 *
 * Expenses are APPEND-ONLY. A mistaken one is corrected by a compensating
 * entry, never by editing the record of what happened.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accounting: AccountingEngineService,
  ) {}

  // ---------------------------------------------------------------- categories
  async createCategory(actor: RequestUser, input: CreateExpenseCategoryInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      await assertExpenseAccount(tx, actor.tenantId, input.accountId);

      const category = await tx.expenseCategory.create({
        data: { businessId: actor.tenantId, name: input.name, accountId: input.accountId, createdBy: actor.id },
      });
      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'ExpenseCategory',
        entityId: category.id,
        after: category,
      });
      return category;
    });
  }

  async updateCategory(actor: RequestUser, id: string, input: UpdateExpenseCategoryInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.expenseCategory.findFirst({ where: { id, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('ExpenseCategory', id);
      if (input.accountId) await assertExpenseAccount(tx, actor.tenantId, input.accountId);

      const after = await tx.expenseCategory.update({
        where: { id },
        data: { name: input.name, accountId: input.accountId, isActive: input.isActive, updatedBy: actor.id },
      });
      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'ExpenseCategory',
        entityId: id,
        before,
        after,
        // Remapping the account changes where FUTURE expenses land. It can
        // never reach a past one: the journal entry an expense posted is
        // permanent, like every other entry in this system.
        reason: input.accountId ? 'Expense category remapped - historical entries are unaffected' : undefined,
      });
      return after;
    });
  }

  async listCategories(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, async (tx) =>
      tx.expenseCategory.findMany({
        where: { businessId: actor.tenantId },
        include: { account: { select: { id: true, code: true, name: true } } },
        orderBy: { name: 'asc' },
      }),
    );
  }

  // ---------------------------------------------------------------- expenses
  async create(actor: RequestUser, input: CreateExpenseInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.expense.findFirst({
          where: { businessId: actor.tenantId, idempotencyKey: input.idempotencyKey },
        });
        if (existing) {
          assertIdempotentReplayMatches(
            {
              expenseCategoryId: existing.expenseCategoryId,
              amount: existing.amount.toString(),
              paymentMethod: existing.paymentMethod,
            },
            {
              expenseCategoryId: input.expenseCategoryId,
              amount: new Prisma.Decimal(input.amount).toString(),
              paymentMethod: input.paymentMethod,
            },
          );
          return existing;
        }
      }

      const category = await tx.expenseCategory.findFirst({
        where: { id: input.expenseCategoryId, businessId: actor.tenantId },
        include: { account: { select: { id: true, isActive: true } } },
      });
      if (!category) throw new NotFoundDomainError('ExpenseCategory', input.expenseCategoryId);
      if (!category.isActive) {
        throw new ConflictDomainError('This expense category has been retired', { expenseCategoryId: category.id });
      }

      // A CASH expense leaves a drawer, so it needs one open. Anything else
      // did not, and must NOT claim a shift: an expense paid by bank
      // transfer attributed to a till would be counted as a shortage at
      // blind close - money the cashier never touched. The DB CHECK
      // `expenses_cash_requires_shift` makes that structural.
      const shift = input.paymentMethod === 'CASH' ? await findActiveShift(tx, actor.tenantId, actor.id) : null;
      if (input.paymentMethod === 'CASH' && !shift) {
        throw new ConflictDomainError('An open shift is required to pay an expense in cash');
      }

      // The branch comes from the shift for a cash expense, and from the
      // business's own default otherwise. A client naming a branch could
      // charge an expense to one it never touched.
      const branchId = shift
        ? (await tx.shift.findUniqueOrThrow({ where: { id: shift.id }, select: { branchId: true } })).branchId
        : (await tx.branch.findFirstOrThrow({ where: { businessId: actor.tenantId }, orderBy: { createdAt: 'asc' } })).id;

      const id = randomUUID();
      const amount = new Prisma.Decimal(input.amount);
      const expense = await tx.expense.create({
        data: {
          id,
          businessId: actor.tenantId,
          branchId,
          expenseCategoryId: category.id,
          shiftId: shift?.id,
          // `expenses` is append-only at the DB privilege level, so the
          // number is computed from the id up front rather than filled in
          // with a follow-up update.
          expenseNumber: documentNumberFromId('EXP', id),
          idempotencyKey: input.idempotencyKey,
          amount,
          paymentMethod: input.paymentMethod,
          reference: input.reference,
          description: input.description,
          expenseDate: input.expenseDate ? new Date(input.expenseDate) : new Date(),
          createdBy: actor.id,
        },
      });

      if (shift) {
        await recordCashTransaction(tx, {
          businessId: actor.tenantId,
          shiftId: shift.id,
          type: 'EXPENSE',
          amount,
          referenceType: 'Expense',
          referenceId: expense.id,
          reason: input.description ?? `Expense ${expense.expenseNumber}`,
          createdBy: actor.id,
        });
      }

      const lines = await buildExpenseJournalLines(tx, actor.tenantId, {
        expenseAccountId: category.accountId,
        method: input.paymentMethod,
        amount,
      });
      if (lines.length > 0) {
        await this.accounting.postEntry(tx, {
          businessId: actor.tenantId,
          entryDate: expense.expenseDate,
          sourceType: 'Expense',
          sourceId: expense.id,
          description: input.description ?? `Expense ${expense.expenseNumber}`,
          createdBy: actor.id,
          lines,
        });
      }

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Expense',
        entityId: expense.id,
        after: expense,
      });

      return expense;
    });
  }

  async list(actor: RequestUser, query: ExpenseListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const where: Prisma.ExpenseWhereInput = {
        businessId: actor.tenantId,
        ...(query.expenseCategoryId ? { expenseCategoryId: query.expenseCategoryId } : {}),
        ...(query.shiftId ? { shiftId: query.shiftId } : {}),
        ...(query.from || query.to
          ? {
              expenseDate: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      };
      const [total, data] = await Promise.all([
        tx.expense.count({ where }),
        tx.expense.findMany({
          where,
          include: { category: { select: { id: true, name: true } } },
          orderBy: { expenseDate: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);
      return { data, meta: { total, page: query.page, limit: query.limit } };
    });
  }
}

/**
 * An expense category must debit an EXPENSE account. Letting one debit
 * Revenue or Inventory would corrupt the very statements the feature
 * exists to feed, and the account's type is only knowable here.
 */
async function assertExpenseAccount(tx: Parameters<typeof buildExpenseJournalLines>[0], businessId: string, accountId: string) {
  const account = await tx.account.findFirst({
    where: { id: accountId, businessId },
    select: { id: true, type: true, isActive: true },
  });
  if (!account) throw new NotFoundDomainError('Account', accountId);
  if (account.type !== 'EXPENSE') {
    throw new ValidationFailedError('An expense category must post to an EXPENSE account', {
      accountId,
      accountType: account.type,
    });
  }
  if (!account.isActive) {
    throw new ValidationFailedError('That account has been deactivated', { accountId });
  }
}
