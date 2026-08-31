import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createExpenseCategorySchema,
  CreateExpenseCategoryInput,
  updateExpenseCategorySchema,
  UpdateExpenseCategoryInput,
  createExpenseSchema,
  CreateExpenseInput,
  expenseListQuerySchema,
  ExpenseListQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { ExpensesService } from '../application/expenses/expenses.service';

/**
 * Phase 10 (10H) — expenses.
 *
 * `expenses.create` and `expenses.manage_categories` are separate
 * permissions on purpose: deciding WHICH GL account a kind of expense
 * lands in is an accounting decision, while recording that the window
 * cleaner was paid is not.
 *
 * There is deliberately no update and no delete on an expense. It is a
 * financial event, and a mistaken one is corrected by a compensating
 * entry - the same posture every other ledger here takes, made structural
 * by the SELECT+INSERT grant.
 */
@Controller()
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @RequirePermissions('expenses.view')
  @Get('expense-categories')
  async listCategories(@CurrentUser() user: RequestUser) {
    return { data: await this.expenses.listCategories(user) };
  }

  @RequirePermissions('expenses.manage_categories')
  @Post('expense-categories')
  async createCategory(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createExpenseCategorySchema)) body: CreateExpenseCategoryInput,
  ) {
    return { data: await this.expenses.createCategory(user, body) };
  }

  @RequirePermissions('expenses.manage_categories')
  @Patch('expense-categories/:id')
  async updateCategory(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateExpenseCategorySchema)) body: UpdateExpenseCategoryInput,
  ) {
    return { data: await this.expenses.updateCategory(user, id, body) };
  }

  @RequirePermissions('expenses.view')
  @Get('expenses')
  async list(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(expenseListQuerySchema)) query: ExpenseListQuery) {
    return this.expenses.list(user, query);
  }

  @RequirePermissions('expenses.create')
  @Post('expenses')
  async create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createExpenseSchema)) body: CreateExpenseInput) {
    return { data: await this.expenses.create(user, body) };
  }
}
