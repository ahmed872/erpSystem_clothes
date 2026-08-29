import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  journalEntryListQuerySchema,
  reverseJournalEntrySchema,
  trialBalanceQuerySchema,
  JournalEntryListQuery,
  ReverseJournalEntryInput,
  TrialBalanceQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { ListJournalEntriesUseCase } from '../application/journal/list-journal-entries.use-case';
import { GetJournalEntryUseCase } from '../application/journal/get-journal-entry.use-case';
import { ReverseJournalEntryUseCase } from '../application/journal/reverse-journal-entry.use-case';
import { GetTrialBalanceUseCase } from '../application/journal/get-trial-balance.use-case';

@Controller('accounting/journal-entries')
export class JournalController {
  constructor(
    private readonly listEntries: ListJournalEntriesUseCase,
    private readonly getEntry: GetJournalEntryUseCase,
    private readonly reverseEntry: ReverseJournalEntryUseCase,
    private readonly getTrialBalance: GetTrialBalanceUseCase,
  ) {}

  @RequirePermissions('accounting.journal.view')
  @Get()
  async list(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(journalEntryListQuerySchema)) query: JournalEntryListQuery) {
    return this.listEntries.execute(user, query);
  }

  @RequirePermissions('accounting.journal.view')
  @Get('trial-balance')
  async trialBalance(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(trialBalanceQuerySchema)) query: TrialBalanceQuery) {
    return { data: await this.getTrialBalance.execute(user, query) };
  }

  @RequirePermissions('accounting.journal.view')
  @Get(':id')
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.getEntry.execute(user, id) };
  }

  @RequirePermissions('accounting.journal.reverse')
  @Post(':id/reverse')
  async reverse(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ZodValidationPipe(reverseJournalEntrySchema)) body: ReverseJournalEntryInput) {
    return { data: await this.reverseEntry.execute(user, id, body) };
  }
}
