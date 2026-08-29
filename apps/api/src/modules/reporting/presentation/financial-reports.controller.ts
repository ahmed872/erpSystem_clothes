import { Controller, Get, Query } from '@nestjs/common';
import {
  generalLedgerQuerySchema,
  reportRangeQuerySchema,
  balanceSheetQuerySchema,
  receivablesQuerySchema,
  GeneralLedgerQuery,
  ReportRangeQuery,
  BalanceSheetQuery,
  ReceivablesQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { FinancialReportsUseCase } from '../application/financial/financial-reports.use-case';

@Controller('reports/financial')
export class FinancialReportsController {
  constructor(private readonly financial: FinancialReportsUseCase) {}

  @RequirePermissions('reports.financial.view')
  @Get('general-ledger')
  async generalLedger(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(generalLedgerQuerySchema)) query: GeneralLedgerQuery) {
    return this.financial.generalLedger(user, query);
  }

  @RequirePermissions('reports.financial.view')
  @Get('profit-and-loss')
  async profitAndLoss(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(reportRangeQuerySchema)) query: ReportRangeQuery) {
    return this.financial.profitAndLoss(user, query);
  }

  @RequirePermissions('reports.financial.view')
  @Get('balance-sheet')
  async balanceSheet(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(balanceSheetQuerySchema)) query: BalanceSheetQuery) {
    return this.financial.balanceSheet(user, query);
  }

  @RequirePermissions('reports.financial.view')
  @Get('receivables')
  async receivables(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(receivablesQuerySchema)) query: ReceivablesQuery) {
    return this.financial.receivables(user, query);
  }

  @RequirePermissions('reports.financial.view')
  @Get('payables')
  async payables(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(receivablesQuerySchema)) query: ReceivablesQuery) {
    return this.financial.payables(user, query);
  }
}
