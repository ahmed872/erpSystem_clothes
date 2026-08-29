import { Module } from '@nestjs/common';
import { AccountsController } from './presentation/accounts.controller';
import { JournalController } from './presentation/journal.controller';
import { PeriodsController } from './presentation/periods.controller';
import { ListAccountsUseCase } from './application/accounts/list-accounts.use-case';
import { CreateAccountUseCase } from './application/accounts/create-account.use-case';
import { UpdateAccountUseCase } from './application/accounts/update-account.use-case';
import { DeactivateAccountUseCase } from './application/accounts/deactivate-account.use-case';
import { ListJournalEntriesUseCase } from './application/journal/list-journal-entries.use-case';
import { GetJournalEntryUseCase } from './application/journal/get-journal-entry.use-case';
import { ReverseJournalEntryUseCase } from './application/journal/reverse-journal-entry.use-case';
import { GetAccountBalanceUseCase } from './application/journal/get-account-balance.use-case';
import { GetTrialBalanceUseCase } from './application/journal/get-trial-balance.use-case';
import { OpenPeriodUseCase } from './application/periods/open-period.use-case';
import { ClosePeriodUseCase } from './application/periods/close-period.use-case';
import { ReopenPeriodUseCase } from './application/periods/reopen-period.use-case';
import { ListPeriodsUseCase } from './application/periods/list-periods.use-case';

@Module({
  controllers: [AccountsController, JournalController, PeriodsController],
  providers: [
    ListAccountsUseCase,
    CreateAccountUseCase,
    UpdateAccountUseCase,
    DeactivateAccountUseCase,
    ListJournalEntriesUseCase,
    GetJournalEntryUseCase,
    ReverseJournalEntryUseCase,
    GetAccountBalanceUseCase,
    GetTrialBalanceUseCase,
    OpenPeriodUseCase,
    ClosePeriodUseCase,
    ReopenPeriodUseCase,
    ListPeriodsUseCase,
  ],
})
export class AccountingModule {}
