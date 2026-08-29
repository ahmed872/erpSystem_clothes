import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { createAccountSchema, updateAccountSchema, accountListQuerySchema, CreateAccountInput, UpdateAccountInput, AccountListQuery } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { ListAccountsUseCase } from '../application/accounts/list-accounts.use-case';
import { CreateAccountUseCase } from '../application/accounts/create-account.use-case';
import { UpdateAccountUseCase } from '../application/accounts/update-account.use-case';
import { DeactivateAccountUseCase } from '../application/accounts/deactivate-account.use-case';
import { GetAccountBalanceUseCase } from '../application/journal/get-account-balance.use-case';

@Controller('accounting/accounts')
export class AccountsController {
  constructor(
    private readonly listAccounts: ListAccountsUseCase,
    private readonly createAccount: CreateAccountUseCase,
    private readonly updateAccount: UpdateAccountUseCase,
    private readonly deactivateAccount: DeactivateAccountUseCase,
    private readonly getBalance: GetAccountBalanceUseCase,
  ) {}

  @RequirePermissions('accounting.accounts.view')
  @Get()
  async list(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(accountListQuerySchema)) query: AccountListQuery) {
    return this.listAccounts.execute(user, query);
  }

  @RequirePermissions('accounting.accounts.create')
  @Post()
  async create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createAccountSchema)) body: CreateAccountInput) {
    return { data: await this.createAccount.execute(user, body) };
  }

  @RequirePermissions('accounting.accounts.edit')
  @Patch(':id')
  async update(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ZodValidationPipe(updateAccountSchema)) body: UpdateAccountInput) {
    return { data: await this.updateAccount.execute(user, id, body) };
  }

  @RequirePermissions('accounting.accounts.delete')
  @Delete(':id')
  async deactivate(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.deactivateAccount.execute(user, id) };
  }

  @RequirePermissions('accounting.journal.view')
  @Get(':id/balance')
  async balance(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.getBalance.execute(user, id) };
  }
}
